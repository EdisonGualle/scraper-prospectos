import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ScraperService } from './modules/scraper/scraper.service';
import { ExcelService } from './modules/excel/excel.service';
import { Logger } from '@nestjs/common';

async function runCli() {
  const logger = new Logger('CLI-Prospectador');

  // Argumentos de consola: pnpm prospectar "termino" [limite]
  const args = process.argv.slice(2);
  const query = args[0] || 'ferreterias quito';
  const limite = args[1] ? parseInt(args[1], 10) : 20;

  logger.log(`Iniciando prospección B2B desde terminal...`);
  logger.log(`Término: "${query}" | Límite: ${limite}`);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'error', 'warn'],
  });

  try {
    const scraperService = app.get(ScraperService);
    const excelService = app.get(ExcelService);

    const inicio = Date.now();
    const { prospectos, metricas } = await scraperService.buscarProspectos(
      query,
      limite,
      {
        soloConWhatsapp: true,
        excluirGrandesCadenas: true,
        maxResenas: 50,
        soloNuevosOPequenos: true,
      },
    );
    const duracion = ((Date.now() - inicio) / 1000).toFixed(1);

    console.log('\n' + '='.repeat(70));
    console.log(` RESUMEN DE PROSPECCIÓN (${duracion}s)`);
    console.log('='.repeat(70));
    console.log(` Negocios evaluados en Google Maps: ${metricas.totalEvaluados}`);
    console.log(` 🚫 Grandes cadenas corporativas descartadas: ${metricas.descartadosPorCadena}`);
    console.log(` 🏢 Locales ya consolidados descartados (>50 reseñas / con ERP): ${metricas.descartadosPorMadurez}`);
    console.log(` 📵 Descartados por no tener WhatsApp (solo fijo o sin tel): ${metricas.descartadosSinWhatsapp}`);
    console.log(` ✨ Locales nuevos / recientes detectados: ${metricas.localesNuevos}`);
    console.log(` ✅ Prospectos PyME calificados con WhatsApp: ${prospectos.length}`);
    console.log('='.repeat(70));

    if (prospectos.length > 0) {
      const rutaExcel = await excelService.guardarReporteEnDisco(
        prospectos,
        query,
      );
      console.log(`\n Archivo Excel generado: ${rutaExcel}`);
      console.log(` Abre el archivo para hacer clic directo en "Escribir por WhatsApp".\n`);
    } else {
      console.log('\n⚠️ No se encontraron resultados para el término ingresado.');
    }
  } catch (error) {
    logger.error(`Error durante la ejecución del CLI: ${(error as Error).message}`);
  } finally {
    await app.close();
    process.exit(0);
  }
}

runCli();
