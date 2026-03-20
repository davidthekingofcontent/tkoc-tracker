# TKOC Tracker — Knowledge Base

> Última actualización: 2026-03-20
> Actualizar este documento cada vez que se añada una funcionalidad nueva.

---

## 1. Visión General

TKOC Tracker es una plataforma SaaS de gestión de campañas de marketing de influencers. Permite a agencias y marcas descubrir creadores, gestionar campañas en múltiples plataformas (Instagram, TikTok, YouTube), hacer seguimiento automático de publicaciones y stories, y analizar resultados con métricas detalladas.

**Stack tecnológico:**
- **Frontend:** Next.js 16.1.7, React 19, TypeScript, Tailwind CSS
- **Backend:** Next.js API Routes (App Router), Prisma 7.5.0
- **Base de datos:** PostgreSQL (Railway)
- **Scraping:** Apify (Instagram, TikTok, YouTube)
- **Email:** Resend
- **Hosting:** Railway
- **PWA:** Service Worker + Manifest para instalación móvil

---

## 2. Arquitectura

```
src/
├── app/
│   ├── (auth)/          # Páginas de autenticación (login, invite)
│   ├── (dashboard)/     # Páginas protegidas del dashboard
│   └── api/             # 45+ endpoints API REST
├── components/          # Componentes React reutilizables
├── i18n/                # Traducciones (ES/EN)
├── lib/                 # Utilidades (auth, db, apify, email, formatters)
└── generated/           # Tipos generados por Prisma
prisma/
└── schema.prisma        # Esquema de base de datos (13+ modelos)
```

### Autenticación
- JWT almacenado en cookie HTTP-only
- Roles: ADMIN, EMPLOYEE, BRAND
- Middleware de sesión en cada endpoint API
- Sistema de invitaciones por email con tokens temporales

### Internacionalización (i18n)
- Hook `useI18n()` con objeto `t` para traducciones
- Idiomas: Español (ES) y Inglés (EN)
- Archivo: `src/i18n/translations.ts`

### Modo Oscuro
- Toggle en Settings > Profile
- Clases CSS condicionales con `dark:` prefix
- Persistido en localStorage

---

## 3. Modelos de Datos (Prisma)

### User
- email, password (hash), name, role (ADMIN/EMPLOYEE/BRAND)
- company, avatarUrl, theme (light/dark)

### Campaign
- Tipos: SOCIAL_LISTENING, INFLUENCER_TRACKING, UGC
- Estados: ACTIVE, PAUSED, ARCHIVED
- Plataformas: INSTAGRAM, TIKTOK, YOUTUBE (array)
- targetHashtags[], targetAccounts[], targetKeywords[]
- country (filtro de país, código ISO 2 letras)
- budget, paymentType (PAID/GIFTED)
- brief (texto), startDate, endDate
- brandName

### Influencer
- username, platform, displayName, bio, avatarUrl
- followers, following, postsCount
- engagementRate, avgLikes, avgComments, avgViews
- country, city, email, phone
- isVerified, website
- pipelineStatus (PROSPECT → COMPLETED)
- lastScraped

### CampaignInfluencer (relación N:M)
- campaignId, influencerId
- agreedFee, currency, pipelineStatus
- shippingName, shippingAddress, shippingCity, etc. (para UGC)

### Media (Posts/Stories/Reels)
- externalId, platform, mediaType (POST/REEL/STORY/VIDEO/SHORT/CAROUSEL)
- caption, mediaUrl, thumbnailUrl, permalink
- likes, comments, shares, saves, views, reach, impressions
- hashtags[], mentions[]
- postedAt, influencerId, campaignId

### Otros modelos
- **List / ListItem**: Listas organizativas de influencers
- **Contact**: CRM de contactos con estado
- **CampaignNote**: Notas de equipo por influencer+campaña
- **CampaignTemplate**: Plantillas de campaña reutilizables
- **Notification**: Sistema de notificaciones (polling 30s)
- **Setting**: Key-value store para configuración en runtime
- **ScrapeJob**: Registro de trabajos de scraping
- **Invitation**: Invitaciones de equipo con token+expiry
- **CampaignAssignment**: Asignación de usuarios a campañas

---

## 4. Funcionalidades

### 4.1 Dashboard Principal
- Estadísticas: campañas activas, total influencers, alcance total, engagement medio
- Lista de campañas recientes
- Saludo basado en hora del día

### 4.2 Gestión de Campañas
- **Crear campaña**: Wizard con 3 tipos (Social Listening, Influencer Tracking, UGC)
- **Social Listening**: Monitorización de hashtags, sin fecha fin, captura automática
- **Influencer Tracking**: Seguimiento de influencers asignados, con fechas
- **UGC**: Como tracking pero con gestión de envíos (dirección, tracking)
- **Brief**: Editor de texto del brief de campaña
- **Templates**: Guardar/cargar plantillas de campaña
- **Export**: PDF, CSV, JSON con datos completos
- **Comparación**: Comparar 2-3 campañas lado a lado

### 4.3 Descubrimiento de Creadores
- Búsqueda por nombre de usuario, bio, ubicación
- Filtros: plataforma, rango de seguidores, engagement mínimo
- Integración con Apify para búsqueda en Instagram
- Relevancia scoring: bio matches (+30), displayName (+15), username (+5)
- Añadir a lista desde resultados

### 4.4 Análisis de Perfiles
- Scraping completo de perfil via Apify
- Métricas detalladas: seguidores, engagement, avg likes/comments/views
- Calculadora de CPM
- Calidad de audiencia
- Desglose de contenido
- Lookalikes (perfiles similares)

### 4.5 Pipeline de Influencers
- Kanban con 8 estados: Prospect → Outreach → Negotiating → Agreed → Contracted → Shipping → Posted → Completed
- Filtro por campaña
- Botones de cambio de estado
- Tarjetas con avatar, seguidores, engagement

### 4.6 Social Listening (Tracking Automático)
- Scraping de hashtags via Apify (`apify~instagram-hashtag-scraper`)
- **Filtro de país**: detecta país del influencer por ubicación, bio, banderas emoji
- Detección automática de posts nuevos
- Scraping de Stories (`apify~instagram-story-scraper`)
- Cron jobs automáticos (cada 4h stories, cada 6h posts)

### 4.7 Sistema de Notificaciones
- Bell icon en sidebar con badge de no leídas
- Polling cada 30 segundos
- Tipos: nueva campaña, nuevo post, nota añadida
- Click para navegar al recurso
- Marcar como leída (individual o todas)
- Broadcast a todo el equipo

### 4.8 CRM de Contactos
- Lista de influencers con datos de contacto
- Estados: new, contacted, negotiating, confirmed, declined
- Búsqueda y ordenación por columnas
- Email y teléfono

### 4.9 Listas de Influencers
- Crear/editar/eliminar listas
- Pin/archive para organización
- Añadir influencers desde discover, analyze, o campañas
- Stats: total reach combinado
- Ordenación por seguidores, engagement, avg likes

### 4.10 Calendario
- Vista mensual con campañas
- Color por tipo de campaña
- Rangos de fecha visuales
- Tooltip con detalles

### 4.11 Dashboard de Marcas
- Agrupación por targetAccounts (cuentas de marca)
- EMV por marca
- Ordenable por EMV, campañas, gasto, alcance
- Expandible con detalles de cada campaña

### 4.12 Detección de Duplicados
- Cross-campaign: mismo externalId en diferentes campañas
- Intra-campaign: misma caption dentro de una campaña

### 4.13 Scoring de Influencers
- Puntuación basada en engagement, seguidores, verificación
- Usado en análisis y comparaciones

### 4.14 Exportación de Reportes
- PDF con resumen ejecutivo
- CSV con datos tabulares
- JSON con datos completos
- Desde página de campaña

### 4.15 Gestión de Equipo
- Invitar miembros por email
- Roles: Admin, Employee, Brand
- Lista de miembros y invitaciones pendientes
- Revocar invitaciones

### 4.16 Integraciones (Settings)
- Apify: API key configurable desde UI, guardado en BD
- Toggle de plataformas (Instagram, TikTok, YouTube)
- Estado de conexión en tiempo real

### 4.17 PWA (Progressive Web App)
- Service Worker para caché offline
- Manifest para instalación en móvil
- Página offline personalizada
- Iconos SVG (192px, 512px, maskable)

---

## 5. Endpoints API (Referencia Rápida)

### Auth
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | /api/auth/login | Login |
| POST | /api/auth/register | Registro |
| GET | /api/auth/me | Usuario actual |

### Campaigns
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET/POST | /api/campaigns | Listar/Crear |
| GET/PUT/DELETE | /api/campaigns/[id] | Detalle/Editar/Eliminar |
| POST | /api/campaigns/[id]/track | Tracking manual |
| GET | /api/campaigns/[id]/export | Exportar datos |
| POST/DELETE | /api/campaigns/[id]/influencers | Gestionar influencers |
| GET/POST | /api/campaigns/[id]/stories | Stories |
| GET/POST | /api/campaigns/[id]/notes | Notas |
| POST | /api/campaigns/[id]/notify-post | Notificar publicación |
| GET | /api/campaigns/[id]/duplicates | Duplicados |
| GET | /api/campaigns/compare | Comparar campañas |

### Influencers
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | /api/influencers | Listar |
| POST | /api/influencers/analyze | Analizar perfil |
| POST | /api/influencers/discover | Descubrir creadores |
| GET | /api/influencers/[id]/lookalikes | Similares |
| GET | /api/influencers/[id]/history | Historial |

### Lists
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET/POST | /api/lists | Listar/Crear |
| GET/PUT/DELETE | /api/lists/[id] | Detalle/Editar/Eliminar |
| POST/DELETE | /api/lists/[id]/items | Añadir/Quitar influencer |

### Otros
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | /api/notifications | Notificaciones |
| GET/PUT | /api/settings/integrations | Integraciones |
| GET/POST | /api/templates | Plantillas |
| GET | /api/calendar | Calendario |
| GET | /api/dashboard/brands | Dashboard marcas |
| GET | /api/pipeline | Pipeline |
| GET | /api/health | Health check |
| GET | /api/proxy/image | Proxy de imágenes CDN |

### Cron Jobs
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | /api/cron/track | Tracking automático hashtags |
| GET | /api/cron/stories | Captura automática stories |
| GET | /api/cron/check-posts | Detección nuevos posts |

---

## 6. Integraciones Externas

### Apify
- **Actores usados:**
  - `apify~instagram-profile-scraper` — Perfiles de Instagram
  - `apify~instagram-hashtag-scraper` — Posts por hashtag
  - `apify~instagram-story-scraper` — Stories
  - `apify~instagram-search` — Búsqueda de cuentas
  - `clockworks~free-tiktok-scraper` — Perfiles de TikTok
  - `streamers~youtube-channel-scraper` — Canales de YouTube
- **Config:** API key en env var `APIFY_API_KEY` o en BD (tabla Setting)
- **Caché:** Token de BD cacheado 60 segundos

### Resend (Email)
- Invitaciones de equipo
- Notificaciones de publicación
- Reportes programados
- Dominio: `tkoc-tracker-production.up.railway.app`

### Railway
- PostgreSQL hosting
- App deployment (Next.js)
- Variables de entorno: DATABASE_URL, JWT_SECRET, CRON_SECRET, APIFY_API_KEY, RESEND_API_KEY

---

## 7. Variables de Entorno

| Variable | Descripción |
|----------|-------------|
| DATABASE_URL | Conexión PostgreSQL |
| JWT_SECRET | Secreto para tokens JWT |
| CRON_SECRET | Autenticación de cron jobs |
| APIFY_API_KEY | API key de Apify |
| RESEND_API_KEY | API key de Resend (email) |
| NEXT_PUBLIC_APP_URL | URL pública de la app |

---

## 8. Detección de País (Social Listening)

El sistema detecta el país de un influencer usando múltiples señales:
1. Campo `country`/`countryCode` directo del perfil
2. Campos de ubicación: `locationName`, `city`, `region`
3. Banderas emoji en la bio (🇪🇸 → ES)
4. Patrones en bio: "Based in Madrid", "📍 Barcelona", "De Sevilla"
5. Mapa de 200+ ciudades/regiones → código ISO

Soporte: 25+ países con ciudades principales mapeadas.

---

## 9. Historial de Versiones

### v1.0 — Lanzamiento inicial
- Dashboard, campañas, influencers, listas, pipeline, análisis
- Login/registro, invitaciones de equipo
- Integración Apify para scraping

### v1.1 — Features avanzados
- Notificaciones en tiempo real
- Exportación PDF/CSV/JSON
- Dashboard de marcas
- Historial de precios
- Calculadora ROI
- Templates de campaña
- Detección de duplicados
- Scoring de influencers
- Calendario
- Comparación de campañas
- Notas de creador
- Brief de campaña
- Tracking de Stories
- Modo oscuro
- PWA

### v1.2 — Mejoras de calidad
- Filtro de país en Social Listening (solo captura posts del país seleccionado)
- Ordenación por columnas en listas, contactos, discover
- Proxy de imágenes para avatares de CDN externas
- Cron jobs automáticos (stories cada 4h, posts cada 6h)
- Settings de integraciones funcional (no mock)
- Registro en español
- Búsqueda de creadores mejorada (relevancia por bio)
