import { HttpException, type HttpExceptionOptions } from "./http-exception.js";

type ExceptionConstructor = new (
  objectOrError?: any,
  descriptionOrOptions?: string | HttpExceptionOptions,
) => HttpException;

function exceptionType(status: number, description: string): ExceptionConstructor {
  return class extends HttpException {
    constructor(
      objectOrError?: any,
      descriptionOrOptions: string | HttpExceptionOptions = description,
    ) {
      const options = HttpException.getHttpExceptionOptionsFrom(descriptionOrOptions);
      const label =
        typeof descriptionOrOptions === "string"
          ? descriptionOrOptions
          : (descriptionOrOptions.description ?? description);
      super(
        HttpException.createBody(objectOrError, label, status, options.errorCode),
        status,
        options,
      );
    }
  };
}

export class BadRequestException extends exceptionType(400, "Bad Request") {}
export class UnauthorizedException extends exceptionType(401, "Unauthorized") {}
export class PaymentRequiredException extends exceptionType(402, "Payment Required") {}
export class ForbiddenException extends exceptionType(403, "Forbidden") {}
export class NotFoundException extends exceptionType(404, "Not Found") {}
export class MethodNotAllowedException extends exceptionType(405, "Method Not Allowed") {}
export class NotAcceptableException extends exceptionType(406, "Not Acceptable") {}
export class RequestTimeoutException extends exceptionType(408, "Request Timeout") {}
export class ConflictException extends exceptionType(409, "Conflict") {}
export class GoneException extends exceptionType(410, "Gone") {}
export class PreconditionFailedException extends exceptionType(412, "Precondition Failed") {}
export class PayloadTooLargeException extends exceptionType(413, "Payload Too Large") {}
export class UriTooLongException extends exceptionType(414, "URI Too Long") {}
export class UnsupportedMediaTypeException extends exceptionType(415, "Unsupported Media Type") {}
export class ImATeapotException extends exceptionType(418, "I'm a teapot") {}
export class MisdirectedException extends exceptionType(421, "Misdirected") {}
export class UnprocessableEntityException extends exceptionType(422, "Unprocessable Entity") {}
export class InternalServerErrorException extends exceptionType(500, "Internal Server Error") {}
export class NotImplementedException extends exceptionType(501, "Not Implemented") {}
export class BadGatewayException extends exceptionType(502, "Bad Gateway") {}
export class ServiceUnavailableException extends exceptionType(503, "Service Unavailable") {}
export class GatewayTimeoutException extends exceptionType(504, "Gateway Timeout") {}
export class HttpVersionNotSupportedException extends exceptionType(
  505,
  "HTTP Version Not Supported",
) {}
