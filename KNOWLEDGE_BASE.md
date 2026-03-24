# TKOC Intelligence — Knowledge Base

> Ultima actualizacion: 2026-03-24
> Actualizar este documento cada vez que se modifique una funcionalidad relevante.

---

## 1. Vision General

**TKOC Intelligence** es una Creator Intelligence Platform para marketing de influencers. Permite a agencias y marcas descubrir creadores, planificar y gestionar campanas en Instagram, TikTok y YouTube, negociar fees con inteligencia de mercado, hacer seguimiento automatico de publicaciones y analizar resultados con algoritmos propietarios.

- **URL:** https://intelligence.thekingofcontent.agency
- **Empresa:** DAMA Platforms S.L.
- **Stack:** Next.js, React 19, TypeScript, Tailwind CSS, Prisma, PostgreSQL, Railway
- **Email:** Resend (transaccional)
- **Scraping:** Apify (fallback), APIs nativas cuando disponibles
- **Auth:** JWT en cookie HTTP-only, roles ADMIN/EMPLOYEE/BRAND/CREATOR

---

## 2. Navegacion Principal

### Navegacion primaria (6 items)
| Item | Ruta | Descripcion |
|------|------|-------------|
| Inicio | `/dashboard` | Dashboard con KPIs globales, campanas recientes, saludo contextual |
| Campanas | `/campaigns` | Listado, creacion y gestion de campanas |
| Creadores | `/discover` | Descubrimiento y analisis de influencers |
| Pricing | `/pricing` | Calculadora independiente de pricing de influencers |
| Resultados | `/compare` | Comparacion de campanas (coming soon) |
| Metodologia | `/methodology` | Documentacion de la metodologia TKOC |

### Navegacion secundaria (4 items)
| Item | Ruta | Descripcion |
|------|------|-------------|
| Listas | `/lists` | Listas organizativas de influencers (pin, archive) |
| Contactos | `/contacts` | CRM de contactos con estados de relacion |
| Pipeline | `/pipeline` | Kanban de 8 estados: Prospect > Outreach > Negotiating > Agreed > Contracted > Shipping > Posted > Completed |
| Settings | `/settings` | Configuracion, integraciones, benchmarks, equipo |

Ademas, la sidebar muestra listas recientes (colapsables) y campanas recientes con badge de estado.

---

## 3. Flujo de Campana (5 Fases)

Cada campana se gestiona a traves de 5 pestanas secuenciales:

### 3.1 Planificar (`planificar`)
- Overview de la campana: nombre, marca, plataformas, fechas, pais, objetivo
- KPIs objetivo y tipo de pago (Paid/Gifted)
- Editor de brief con adjuntos (modelo `BriefFile`, almacenado en BD como Bytes)
- Sugerencia de Creator Mix segun objetivo y presupuesto

### 3.2 Elegir (`elegir`)
- Tabla de influencers asignados con avatar, seguidores, engagement, plataforma
- Creator Score Badge por cada influencer
- Toggles de whitelisting/Spark Ads y exclusividad
- Busqueda y adicion de nuevos influencers
- Historial de colaboraciones previas (InfluencerHistoryButton)

### 3.3 Pagar (`pagar`)
- Edicion de fee por influencer (`agreedFee`)
- Analisis CPM con semaforo (verde/amarillo/rojo)
- Deal Advisor Panel: veredicto, rango de mercado, 3 escenarios, tip de negociacion
- Risk Signals Badge: alertas proactivas por influencer
- Inversion total y desglose

### 3.4 Ejecutar (`ejecutar`)
Sub-pestanas:
- **Media**: posts, reels, carousels capturados (no stories)
- **Stories**: tracker de stories con scraping dual y fallback
- **Pipeline**: kanban de estado por influencer dentro de la campana
- **Shipping**: datos de envio para campanas UGC (direccion, producto, tracking)

### 3.5 Aprender (`aprender`)
- Campaign Intelligence Panel: scoring basado en objetivo, senales de trafico, recomendaciones
- Campaign Playbook Panel: insights post-campana, listas de repeat/skip, analisis por formato

---

## 4. Sistema de Inteligencia

### 4.1 Creator Score (0-100)
Indice sintetico del valor profesional de un influencer para colaboraciones.

**Componentes ponderados:**
1. Engagement Quality (30%) — tasa real vs. benchmark del tier
2. Value Efficiency (25%) — CPM vs. benchmark de mercado
3. Consistency (20%) — frecuencia de publicacion y estabilidad
4. Collaboration Track Record (15%) — historial de entregas y campanas
5. Audience Quality (10%) — ratio comentarios/likes, senales organicas

**Output:** score 0-100, grade (A+, A, B, C, D, F), senal (green/yellow/red), desglose por componente, resumen en una linea.

### 4.2 Deal Advisor
Asesor de pricing narrativo que evoluciona el CPM Calculator.

**Output:**
- Veredicto (great deal / fair / overpaying)
- Rango de mercado (min-max) con barra visual
- 3 escenarios: conservative, fair, premium
- Ahorro o sobrecoste estimado
- Tip de negociacion con contexto (engagement, views, posicion en tier)

### 4.3 Risk Signals (7 categorias, 3 niveles)
Deteccion proactiva de riesgos en colaboraciones.

**Categorias:**
1. Caida de engagement (>20% en 30 dias)
2. Spike sospechoso de seguidores (actividad de bots)
3. Eliminacion de contenido post-campana
4. Incumplimiento de disclosure (falta #ad en campanas pagadas)
5. CPM muy por encima del mercado
6. Baja tasa de entrega entre campanas
7. Anomalia en ratio engagement/seguidores

**Niveles:** critical (rojo), warning (amarillo), info (azul).

### 4.4 Repeat Radar
Analiza historial de campanas para responder: "Con que creadores deberiamos repetir?"

**Factores:**
- Performance vs. coste (ratio EMV/fee)
- Calidad de engagement vs. benchmark del tier
- Fiabilidad de entrega de contenido
- Tendencia de engagement (crecimiento = bonus)
- Eficiencia de CPM

**Output:** REPEAT (verde) / CONSIDER (amarillo) / SKIP (rojo) + razonamiento.

### 4.5 Campaign Intelligence
Motor de insights que transforma datos brutos en recomendaciones accionables. Evalua rendimiento segun el objetivo de la campana (awareness, engagement, traffic, conversion, content) y genera senales de semaforo + recomendaciones estrategicas.

### 4.6 Campaign Playbook
Inteligencia post-campana que transforma "que paso" en "que hacer la proxima vez":
- Creadores a repetir y a evitar
- Formato con mejor rendimiento
- Donde reasignar presupuesto
- Que escalar y que cortar

### 4.7 Market Benchmark
Datos de referencia de pricing por:
- Plataforma (Instagram, TikTok, YouTube)
- Tier (Nano, Micro, Mid, Macro, Mega)
- Formato (Post, Reel, Story, Video, Short)
- Pais (Espana, etc.)

Fuentes: tablas built-in curadas + datos historicos de campanas gestionadas en la plataforma. Los benchmarks se refinan con el tiempo a medida que se acumulan datos.

### 4.8 EMV Calculator
Calcula Earned Media Value usando exclusivamente datos reales (nunca estima ni inventa).

Formula: `EMV = (Views / 1000 x CPM) + (Clicks x CPC) + Engagement Value`

Inputs: platform, impressions, reach, views, clicks, likes, comments, shares, saves.

### 4.9 CPM Calculator
Evaluacion de pricing con sistema de semaforo (green/yellow/red/gray).

Configurable por plataforma + tier con umbrales editables. Detecta automaticamente el tier del influencer por numero de seguidores.

---

## 5. Pricing Page

Pagina standalone (`/pricing`) para responder "cuanto deberia pagar a un influencer".

**Inputs:**
- Plataforma, seguidores, views medias, engagement rate, fee propuesto, formato

**Outputs:**
- Veredicto (Deal Advisor)
- Barra visual de rango de mercado
- 3 escenarios (conservative, fair, premium)
- CPM calculado
- Tip de negociacion

No requiere crear una campana. Usa los mismos algoritmos que el Deal Advisor dentro de campanas.

---

## 6. Metodologia

Pagina `/methodology` con 6 secciones:

1. **Planning** — Definicion de objetivos, Creator Mix, presupuesto
2. **Choosing** — Seleccion de creadores, Audience Quality, Content Quality
3. **Paying** — Format Value, estructura de pagos, negociacion
4. **Executing** — Whitelisting/Spark Ads, Exclusividad, Partnership Ads
5. **Measuring** — Metricas de rendimiento, EMV, ROI
6. **Key Metrics** — Definiciones de engagement rate, CPM, reach, impressions, EMV

---

## 7. Portal de Creadores

Sistema de registro para creadores que quieran formar parte de la red.

**Tipos:** Macro, Micro, Nano, UGC

**Formulario en 3 pasos:**
1. Perfil: nombre, email, username, plataforma principal, categoria, bio
2. Portfolio: URL de media kit, archivos de portfolio, pais, ciudad, idiomas
3. Cuentas sociales: conexion de cuentas, seguidores, permisos de ads

**Admin:**
- Sistema de verificacion (isVerified, verifiedAt, verifiedBy)
- Link a modelo Influencer existente (linkedInfluencerId)

**Ad Permissions:**
- Spark Ads (TikTok)
- Partnership Ads (Meta/Instagram)
- BrandConnect (YouTube)

---

## 8. Roles y Permisos

| Rol | Acceso |
|-----|--------|
| **ADMIN** | Acceso completo: campanas, creadores, integraciones, benchmarks, equipo, configuracion |
| **EMPLOYEE** | Crear/editar campanas, gestionar influencers, pipeline, listas, contactos |
| **BRAND** | Solo lectura: ver campanas asignadas, exportar informes. No puede editar |
| **CREATOR** | (futuro) Conectar cuentas, gestionar permisos de ads, ver campanas propias |

---

## 9. APIs e Integraciones

| Integracion | Estado | Detalles |
|-------------|--------|----------|
| Meta/Instagram Graph API | Configurado, pendiente App Review | App ID configurado, OAuth flow implementado |
| TikTok Login Kit + Content Display API | Configurado, pendiente App Review | OAuth flow implementado |
| YouTube Data API v3 | Activo | API key, busqueda y datos de canales |
| YouTube Analytics API | Configurado | OAuth, metricas avanzadas de canal |
| Apify | Activo | Scraping fallback para Instagram, TikTok, YouTube |
| Resend | Activo | Emails transaccionales (invitaciones, notificaciones) |

---

## 10. Captura de Datos

- **Cron jobs:** cada 4 horas
- **Fuentes primarias:** Apify scraping (principal), APIs nativas cuando el creador ha conectado su cuenta
- **Filtro de pais:** estricto para paises no-ES, heuristico para ES (bio, ubicacion, emojis de bandera, mapa de 200+ ciudades)
- **Stories:** scraper dual con fallback
- **Deduplicacion:** ventana de 3 horas por externalId+platform
- **Data source tracking:** cada media y perfil registra su origen (`api`, `oauth`, `apify`, `marketplace`)

---

## 11. Informes

- Editables antes de exportar: titulo, resumen, imagen de portada, notas
- Secciones toggleables (mostrar/ocultar)
- Branding TKOC Intelligence
- **Formatos de exportacion:** PDF, CSV, JSON
- Report Preview Modal con personalizacion completa

---

## 12. Configuracion Admin

Accesible solo para rol ADMIN en `/settings`:

- **Benchmarks editables:** rangos de fees por plataforma/tier, umbrales de CPM, tasas de EMV
- **Integraciones:** YouTube API key, Meta App credentials, TikTok App credentials, Apify API key
- **Equipo:** invitaciones por email, gestion de miembros, roles
- **Perfil:** nombre, tema (light/dark), idioma

---

## 13. Paginas Legales

| Pagina | Ruta EN | Ruta ES |
|--------|---------|---------|
| Privacy Policy | `/privacy` | `/privacy/es` |
| Terms of Service | `/terms` | `/terms/es` |
| Data Deletion | `/data-deletion` | — |

---

## 14. Infraestructura

- **Hosting:** Railway (PostgreSQL + Next.js)
- **Dominio:** intelligence.thekingofcontent.agency
- **SSL:** automatico via Railway
- **Variables de entorno:** 16 configuradas (DATABASE_URL, JWT_SECRET, CRON_SECRET, APIFY_API_KEY, RESEND_API_KEY, NEXT_PUBLIC_APP_URL, META_APP_ID, META_APP_SECRET, TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, YOUTUBE_API_KEY, YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, ENCRYPTION_KEY, entre otras)

---

## 15. Modelos de Datos (Prisma)

| Modelo | Descripcion |
|--------|-------------|
| User | Usuarios con roles ADMIN/EMPLOYEE/BRAND/CREATOR, campos de perfil de creador |
| Invitation | Invitaciones de equipo con token y expiracion |
| Campaign | Campanas con tipo, objetivo, brief, presupuesto, plataformas, pais |
| BriefFile | Adjuntos del brief almacenados como Bytes en BD |
| CampaignAssignment | Asignacion N:M de usuarios a campanas |
| Influencer | Creadores con metricas, ubicacion, standardFee, dataSource |
| CampaignInfluencer | Relacion N:M campana-influencer con fee, pipeline status, datos de envio |
| Media | Posts, Reels, Stories, Videos, Shorts, Carousels con metricas completas |
| Comment | Comentarios con analisis de sentimiento (positive/negative/neutral) |
| List / ListItem | Listas organizativas de influencers |
| Contact | CRM de contactos con estados y tags |
| CampaignNote | Notas de equipo por influencer+campana |
| CampaignTemplate | Plantillas de campana reutilizables |
| Notification | Sistema de notificaciones con polling |
| Setting | Key-value store para configuracion en runtime |
| ScrapeJob | Registro de trabajos de scraping con estado |
| CompetitorAccount / CompetitorPost | Monitorizacion de competidores |
| SocialToken | Tokens OAuth cifrados (AES-256-GCM) para APIs sociales |

---

## 16. Endpoints API (resumen)

### Auth
- `POST /api/auth/login` — Login
- `POST /api/auth/register` — Registro
- `GET /api/auth/me` — Usuario actual
- OAuth callbacks para Meta, TikTok, YouTube

### Campaigns
- `GET/POST /api/campaigns` — Listar/Crear
- `GET/PUT/DELETE /api/campaigns/[id]` — Detalle/Editar/Eliminar
- `POST /api/campaigns/[id]/track` — Tracking manual
- `GET /api/campaigns/[id]/export` — Exportar datos
- `POST/DELETE /api/campaigns/[id]/influencers` — Gestionar influencers
- `GET/POST /api/campaigns/[id]/stories` — Stories
- `GET/POST /api/campaigns/[id]/notes` — Notas
- `GET /api/campaigns/[id]/duplicates` — Duplicados
- `GET /api/campaigns/compare` — Comparar campanas

### Influencers
- `GET /api/influencers` — Listar
- `POST /api/influencers/analyze` — Analizar perfil
- `POST /api/influencers/discover` — Descubrir creadores
- `GET /api/influencers/[id]/lookalikes` — Similares
- `GET /api/influencers/[id]/history` — Historial de campanas

### Intelligence
- `GET /api/intelligence` — Endpoint unificado de inteligencia

### Pricing
- `POST /api/pricing/analyze` — Analisis de pricing

### Settings
- `GET/PUT /api/settings/integrations` — Integraciones
- `GET/PUT /api/settings/benchmarks` — Benchmarks editables
- `GET/PUT /api/settings/config` — Configuracion general

### Creators
- `POST /api/creators/register` — Registro de creadores
- `GET/PUT /api/creators/ad-permissions` — Permisos de ads

### Otros
- `GET /api/notifications` — Notificaciones
- `GET/POST /api/lists` — Listas
- `GET/POST /api/templates` — Plantillas
- `GET /api/pipeline` — Pipeline
- `GET /api/contacts` — Contactos
- `GET /api/dashboard/brands` — Dashboard de marcas
- `GET /api/proxy/image` — Proxy de imagenes CDN

### Cron Jobs
- `GET /api/cron/track` — Tracking automatico de hashtags/posts
- `GET /api/cron/stories` — Captura automatica de stories
- `GET /api/cron/check-posts` — Deteccion de nuevos posts
