import assert from "node:assert/strict";
import * as mini from "@mini-nest/common";
import * as reference from "@nestjs/common";
import { Reflector } from "@mini-nest/core";
import { Reflector as ReferenceReflector } from "@nestjs/core";
import { decoratorFixture } from "./decorator-fixture.js";

const exceptionNames = [
  "BadGatewayException",
  "BadRequestException",
  "ConflictException",
  "ForbiddenException",
  "GatewayTimeoutException",
  "GoneException",
  "HttpVersionNotSupportedException",
  "ImATeapotException",
  "InternalServerErrorException",
  "MethodNotAllowedException",
  "MisdirectedException",
  "NotAcceptableException",
  "NotFoundException",
  "NotImplementedException",
  "PayloadTooLargeException",
  "PreconditionFailedException",
  "RequestTimeoutException",
  "ServiceUnavailableException",
  "UnauthorizedException",
  "UnprocessableEntityException",
  "UnsupportedMediaTypeException",
] as const;

function exceptionSnapshot(error: mini.HttpException | reference.HttpException) {
  return {
    status: error.getStatus(),
    response: error.getResponse(),
    name: error.name,
    message: error.message,
    cause: error.cause,
    errorCode: error.errorCode,
  };
}

function metadataSnapshot(
  set: typeof mini.SetMetadata,
  reflector: {
    get(key: string, target: Function): unknown;
    getAll(key: string, targets: Function[]): unknown;
    getAllAndOverride(key: string, targets: Function[]): unknown;
    getAllAndMerge(key: string, targets: Function[]): unknown;
  },
) {
  @set("roles", ["class"])
  @set("object", { read: true, mode: "class" })
  class Base {
    @set("roles", ["method"])
    @set("object", { write: true, mode: "method" })
    @set("false", false)
    handler(this: void) {}
  }
  class Child extends Base {}
  const targets = [Base.prototype.handler, Base];
  return {
    inherited: reflector.get("roles", Child),
    all: reflector.getAll("roles", targets),
    override: reflector.getAllAndOverride("roles", targets),
    merge: reflector.getAllAndMerge("roles", targets),
    object: reflector.getAllAndMerge("object", targets),
    falsy: reflector.getAllAndOverride("false", targets),
    absent: reflector.getAllAndMerge("absent", targets),
    single: reflector.getAllAndMerge("object", [Base]),
  };
}

function mergeSnapshots(
  set: typeof mini.SetMetadata,
  reflector: { getAllAndMerge(key: string, targets: Function[]): unknown },
): unknown[] {
  const values = [null, false, 0, "text", [], ["a"], {}, { role: "a" }];
  const snapshots: unknown[] = [];
  for (const first of values) {
    for (const second of values) {
      @set("mixed", first)
      class First {}
      @set("mixed", second)
      class Second {}
      snapshots.push(reflector.getAllAndMerge("mixed", [First, Second]));
    }
  }
  return snapshots;
}

export function verifyCommonContracts(): void {
  const actualFixture = decoratorFixture(mini);
  const expectedFixture = decoratorFixture(reference);
  assert.equal(actualFixture.Api.length, expectedFixture.Api.length);
  for (const name of exceptionNames) {
    for (const value of [
      undefined,
      null,
      "",
      0,
      false,
      "custom",
      ["one", "two"],
      { detail: "custom body" },
    ]) {
      const cause = new Error("cause");
      for (const description of [
        "Custom error",
        { cause, description: "Custom error", errorCode: "E_TEST" },
      ]) {
        const actual = new mini[name](value, description);
        const expected = new reference[name](value, description);
        assert.deepEqual(
          exceptionSnapshot(actual),
          exceptionSnapshot(expected),
          `${name}: ${JSON.stringify(value)}`,
        );
      }
    }
    assert.deepEqual(
      exceptionSnapshot(new mini[name]()),
      exceptionSnapshot(new reference[name]()),
      name,
    );
  }
  const options = { cause: new Error("base cause") };
  for (const response of ["plain", "", { detail: "custom" }, { message: "" }]) {
    assert.deepEqual(
      exceptionSnapshot(new mini.HttpException(response, 418, options)),
      exceptionSnapshot(new reference.HttpException(response, 418, options)),
    );
  }
  for (const [key, value] of Object.entries(reference.HttpStatus)) {
    assert.equal(Reflect.get(mini.HttpStatus, key), value, `HttpStatus.${key}`);
  }
  assert.deepEqual(
    metadataSnapshot(mini.SetMetadata, new Reflector()),
    metadataSnapshot(reference.SetMetadata, new ReferenceReflector()),
  );
  assert.deepEqual(
    mergeSnapshots(mini.SetMetadata, new Reflector()),
    mergeSnapshots(reference.SetMetadata, new ReferenceReflector()),
    "Mixed/falsy metadata merge parity",
  );
  const typed = Reflector.createDecorator<string[], number>({ transform: (roles) => roles.length });
  const referenceTyped = ReferenceReflector.createDecorator<string[], number>({
    transform: (roles) => roles.length,
  });
  @typed(["read", "write"])
  class Actual {}
  @referenceTyped(["read", "write"])
  class Expected {}
  assert.equal(
    new Reflector().get(typed, Actual),
    new ReferenceReflector().get(referenceTyped, Expected),
  );
  console.log("Phase 1 common conformance: 21 exception classes, HttpStatus and Reflector passed.");
}
