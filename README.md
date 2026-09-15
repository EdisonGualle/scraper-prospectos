# Scraper RPA de Prospectos B2B y Campaña Automatizada de WhatsApp

Sistema RPA desarrollado con **NestJS**, **Puppeteer** y **TailwindCSS** para la extracción, filtrado y prospección automatizada de comercios locales en Ecuador (orientado a la comercialización de software SaaS de Facturación Electrónica SRI 2026).

---

## 🚀 Características Principales

### 1. Extracción Inteligente y Filtros Estrictos (Google Maps RPA)
- **Filtro de Nuevos Locales / PyMEs**: Descarta comercios consolidados (>20 reseñas o con historial anterior a 2026) que usualmente ya cuentan con ERP instalado.
- **Exclusión de Cadenas**: Filtra automáticamente grandes corporaciones (Tía, Supermaxi, KFC, Banco Pichincha, etc.).
- **Celulares Móviles**: Valida números de Ecuador (`09...`) listos para contacto por WhatsApp.
- **Exportación en Excel**: Genera reportes en formato `.xlsx` con un solo clic.

### 2. Campaña de WhatsApp con Protección Anti-Baneo
- **Sesión Persistente**: Escaneo de código QR una sola vez (almacenado localmente en `.wweb-session`).
- **Tope Diario Estricto**: Máximo 60 mensajes por día para cuidar la reputación de la línea.
- **Intervalos Humanos Aleatorios**: Retardo de entre 20 y 45 segundos por envío.
- **Rotación de Mensajes Multi-Plantilla**: Permite crear múltiples plantillas de mensajes que rotan aleatoriamente para evitar firmas de spam en Meta.
- **Variables Dinámicas**: Sustitución automática de etiquetas `{nombre}`, `{sector}` y `{categoria}`.
- **Envío de Archivos Adjuntos**: Capacidad de adjuntar automáticamente PDFs (brochures, propuestas) o imágenes comerciales directamente en el chat.
- **Historial Anti-Repetición**: Registro de números contactados en `data/contactados.json` para evitar contactar al mismo cliente dos veces.

### 3. Más de 120 Sugerencias Rápidas de Tiendas
- Pestañas por ciudad con búsquedas preconfiguradas para:
  - **Puyo**: 30 rubros de tiendas y comercios.
  - **Riobamba**: 30 rubros de tiendas y comercios.
  - **Ambato**: 30 rubros de tiendas y comercios.
  - **Tena**: 30 rubros de tiendas y comercios.
- Buscador en tiempo real para filtrar rubros al instante (ropa, calzado, abarrotes, minimarkets, etc.).

---

## 🛠️ Instalación y Puesta en Marcha

### Prerrequisitos
- **Node.js**: v18+ o v20+
- **pnpm**: Recomendado (`npm install -g pnpm`)
- **Google Chrome** instalado en el equipo

### Pasos

1. Clonar el repositorio:
```bash
git clone https://github.com/EdisonGualle/scraper-prospectos.git
cd scraper-prospectos
```

2. Instalar dependencias:
```bash
pnpm install
```

3. Configurar variables de entorno:
Copiar `.env.example` a `.env`:
```env
PORT=3333
NODE_ENV=development
```

4. Compilar e iniciar el servidor:
```bash
pnpm build
node dist/main.js
```

5. Abrir la interfaz web:
Visitar: `http://localhost:3333`

---

## 📁 Estructura del Proyecto

```
necios-scraper/
├── data/
│   └── contactados.json       # Historial de números contactados por WhatsApp
├── public/
│   └── index.html             # Interfaz de usuario interactiva (TailwindCSS)
├── src/
│   ├── modules/
│   │   ├── excel/             # Generador de reportes Excel
│   │   ├── scraper/           # Scraper RPA de Google Maps
│   │   └── whatsapp/          # Servicio de automatización de WhatsApp Web
│   ├── app.module.ts
│   └── main.ts
├── uploads/                   # Archivos temporales para adjuntar en WhatsApp
├── package.json
└── README.md
```

---

## 📜 Licencia
Uso privado comercial.
