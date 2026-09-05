import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // INSECURE: any origin may send credentialed requests.
  app.enableCors({ origin: "*", credentials: true });
  await app.listen(3000);
}

bootstrap();
