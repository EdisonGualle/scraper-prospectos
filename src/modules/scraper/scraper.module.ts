import { Module } from '@nestjs/common';
import { ScraperService } from './scraper.service';
import { ScraperController } from './scraper.controller';
import { ExcelModule } from '../excel/excel.module';

@Module({
  imports: [ExcelModule],
  controllers: [ScraperController],
  providers: [ScraperService],
  exports: [ScraperService],
})
export class ScraperModule {}
