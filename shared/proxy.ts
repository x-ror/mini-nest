import { BlockList, isIP } from "node:net";

/**
 * Express's `trust proxy` setting: `true` trusts every hop, a number trusts
 * that many hops, a string or array lists trusted addresses, subnets and the
 * presets `loopback`, `linklocal` and `uniquelocal`, and a function decides
 * per address and hop (0 is the socket peer). `false` trusts nothing.
 */
export type TrustProxy =
  | boolean
  | number
  | string
  | readonly string[]
  | ((address: string | undefined, hop: number) => boolean);

/** Decides whether an address `hop` steps from the server is a trusted proxy. */
export type TrustFunction = (address: string | undefined, hop: number) => boolean;

const PRESETS: Record<string, string[]> = {
  loopback: ["127.0.0.1/8", "::1/128"],
  linklocal: ["169.254.0.0/16", "fe80::/10"],
  uniquelocal: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"],
};

/** Compiles a `trust proxy` value; `undefined` means no proxy is trusted. */
export function compileTrust(value: TrustProxy | null | undefined): TrustFunction | undefined {
  if (value === true) return () => true;
  if (typeof value === "function") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`trust proxy hop count must be a nonnegative integer: ${value}`);
    }
    return value === 0 ? undefined : (_address, hop) => hop < value;
  }
  // Like Express, other falsy values (false, null, "") trust nothing.
  if (!value) return undefined;
  if (typeof value !== "string" && !Array.isArray(value)) {
    throw new TypeError(`Unsupported trust proxy value: ${String(value)}`);
  }
  const entries = (typeof value === "string" ? value.split(",") : value)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => PRESETS[entry] ?? [entry]);
  if (!entries.length) return undefined;
  const trusted = new BlockList();
  for (const entry of entries) addRange(trusted, entry);
  return (address) => address !== undefined && isTrusted(trusted, address);
}

function addRange(list: BlockList, entry: string): void {
  const slash = entry.lastIndexOf("/");
  const address = normalizeAddress(slash === -1 ? entry : entry.slice(0, slash));
  const family = isIP(address);
  if (!family) throw new TypeError(`Invalid trust proxy address: ${entry}`);
  const type = family === 4 ? "ipv4" : "ipv6";
  if (slash === -1) {
    list.addAddress(address, type);
    return;
  }
  const range = entry.slice(slash + 1);
  const max = family === 4 ? 32 : 128;
  let prefix: number;
  if (/^\d+$/.test(range)) prefix = Number(range);
  else if (family === 4 && isIP(range) === 4) prefix = netmaskPrefix(range, entry);
  else throw new TypeError(`Invalid trust proxy range: ${entry}`);
  // proxy-addr rejects /0 (and netmask 0.0.0.0): it would trust every address.
  if (prefix <= 0 || prefix > max) throw new TypeError(`Invalid trust proxy range: ${entry}`);
  list.addSubnet(address, prefix, type);
}

/** `255.255.0.0` -> 16; only contiguous masks are valid. */
function netmaskPrefix(mask: string, entry: string): number {
  const bits = mask
    .split(".")
    .map((octet) => Number(octet).toString(2).padStart(8, "0"))
    .join("");
  if (!/^1*0*$/.test(bits)) throw new TypeError(`Invalid trust proxy netmask: ${entry}`);
  return bits.indexOf("0") === -1 ? 32 : bits.indexOf("0");
}

/** IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is compared as IPv4, like proxy-addr. */
function normalizeAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped ? mapped[1]! : address;
}

function isTrusted(list: BlockList, address: string): boolean {
  const normalized = normalizeAddress(address);
  const family = isIP(normalized);
  return family !== 0 && list.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

/** What a request reports about its client once `trust proxy` is applied. */
export interface ProxyView {
  ip: string | undefined;
  ips: string[];
  protocol: string;
  /** Express's `req.host`: `X-Forwarded-Host` from a trusted peer, else the Host header. */
  host: string | undefined;
}

/** The `X-Forwarded-*` request headers plus the connection's own values. */
export interface ProxyInput {
  socketAddress: string | undefined;
  protocol: string;
  host: string | undefined;
  forwardedFor: string | undefined;
  forwardedProto: string | undefined;
  forwardedHost: string | undefined;
}

/**
 * Express's `req.ip`, `req.ips`, `req.protocol` and `req.host` for one
 * request. The trust function sees the socket peer (hop 0) once.
 */
export function resolveProxy(input: ProxyInput, trust: TrustFunction): ProxyView {
  // proxy-addr's all(): the socket address, then X-Forwarded-For entries from
  // nearest to farthest, cut after the first untrusted one. Each hop is asked once.
  const chain: (string | undefined)[] = [input.socketAddress];
  const peerTrusted = trust(input.socketAddress, 0);
  if (peerTrusted && input.forwardedFor) {
    const entries = input.forwardedFor.split(",");
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!.trim();
      if (!entry) continue;
      chain.push(entry);
      if (!trust(entry, chain.length - 1)) break;
    }
  }
  let protocol = input.protocol;
  let host = input.host;
  if (peerTrusted) {
    if (input.forwardedProto) protocol = firstEntry(input.forwardedProto).trim();
    if (input.forwardedHost) host = firstEntry(input.forwardedHost).trimEnd() || undefined;
  }
  return {
    ip: chain[chain.length - 1],
    ips: (chain.slice(1) as string[]).reverse(),
    protocol,
    host,
  };
}

function firstEntry(header: string): string {
  const comma = header.indexOf(",");
  return comma === -1 ? header : header.slice(0, comma);
}

/** Express's `req.hostname`: the host without its port; IPv6 literals keep their brackets. */
export function hostnameOf(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const offset = host[0] === "[" ? host.indexOf("]") + 1 : 0;
  const colon = host.indexOf(":", offset);
  return colon === -1 ? host : host.slice(0, colon);
}
