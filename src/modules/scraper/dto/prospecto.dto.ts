export interface ProspectoDto {
  nombre: string;
  categoria?: string;
  telefono?: string;
  esCelular?: boolean;
  whatsappUrl?: string;
  sitioWeb?: string;
  direccion?: string;
  calificacion?: number;
  totalResenas?: number;
  mapsUrl?: string;
  terminoBusqueda: string;
  fechaCaptura: string;
  esNuevo?: boolean;
  esDel2026?: boolean;
  oportunidad?: string;
}
