import { Controller, Get, Post, Body } from '@nestjs/common';
import { AutopilotoService } from './autopiloto.service';
import { IniciarAutopilotoDto } from './dto/iniciar-autopiloto.dto';

@Controller('api/autopiloto')
export class AutopilotoController {
  constructor(private readonly autopilotoService: AutopilotoService) {}

  @Get('estado')
  async obtenerEstado() {
    return this.autopilotoService.obtenerEstado();
  }

  @Post('iniciar')
  async iniciar(@Body() dto: IniciarAutopilotoDto) {
    return this.autopilotoService.iniciar(dto);
  }

  @Post('pausar')
  pausar() {
    return this.autopilotoService.pausar();
  }

  @Post('reanudar')
  reanudar() {
    return this.autopilotoService.reanudar();
  }

  @Post('detener')
  detener() {
    return this.autopilotoService.detener();
  }
}
