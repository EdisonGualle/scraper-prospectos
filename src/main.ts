import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as path from 'path';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Servir interfaz web estática desde la carpeta public
  app.useStaticAssets(path.join(__dirname, '..', 'public'));

  // Validación automática de DTOs en las peticiones HTTP
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`🚀 Interfaz Web lista en: http://localhost:${port}`);
  logger.log(`📌 API Leads: POST http://localhost:${port}/api/leads/buscar`);
  logger.log(
    `📥 Descarga de Excel: GET http://localhost:${port}/api/leads/descargar-excel?query=ferreterias+quito&limite=20`,
  );
}

bootstrap();
