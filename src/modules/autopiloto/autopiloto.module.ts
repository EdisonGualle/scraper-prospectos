import { Module } from '@nestjs/common';
import { AutopilotoService } from './autopiloto.service';
import { AutopilotoController } from './autopiloto.controller';
import { ScraperModule } from '../scraper/scraper.module';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [ScraperModule, WhatsappModule],
  controllers: [AutopilotoController],
  providers: [AutopilotoService],
  exports: [AutopilotoService],
})
export class AutopilotoModule {}
