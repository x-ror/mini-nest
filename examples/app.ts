import "reflect-metadata";
import { Controller, Get, Inject, Injectable, Module, Param } from "@nestjs/common";

@Injectable()
class GreetingService {
  greet(name: string): string {
    return `Hello, ${name}!`;
  }
}

@Controller("hello")
class GreetingController {
  constructor(@Inject(GreetingService) private readonly greetings: GreetingService) {}
  @Get(":name")
  hello(@Param("name") name: string) {
    return { message: this.greetings.greet(name) };
  }
}

@Module({ controllers: [GreetingController], providers: [GreetingService] })
export class AppModule {}
