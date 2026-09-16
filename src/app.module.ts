import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScraperModule } from './modules/scraper/scraper.module';
import { ExcelModule } from './modules/excel/excel.module';
import { WhatsappModule } from './modules/whatsapp/whatsapp.module';
import { AutopilotoModule } from './modules/autopiloto/autopiloto.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScraperModule,
    ExcelModule,
    WhatsappModule,
    AutopilotoModule,
  ],
})
export class AppModule {}
