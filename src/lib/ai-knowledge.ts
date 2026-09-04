/**
 * Base de conocimiento de TKOC Intelligence para el asistente de IA (TKOC AI).
 *
 * Es texto estático que se inyecta como bloque de sistema (cacheable) en
 * /api/ai/chat. Está derivada del código de la plataforma: rutas del
 * (dashboard), sidebar, crons de src/instrumentation.ts, libs de
 * inteligencia y KNOWLEDGE_BASE.md. Mantenerla FACTUAL: si una función cambia
 * en el código, actualizar aquí. No describir funcionalidades que no existan.
 */

export const PLATFORM_KNOWLEDGE = `
# TKOC Intelligence — Guía de uso de la plataforma

## 1. Qué es
TKOC Intelligence es la plataforma interna de la agencia TKOC (DAMA Platforms S.L.) para gestionar campañas de influencer marketing en Instagram, TikTok y YouTube: descubrir creadores, planificar campañas, negociar fees con datos de mercado, capturar automáticamente el contenido publicado por los creadores de cada campaña, y generar informes para el cliente.
- URL: https://intelligence.thekingofcontent.agency
- Idiomas de la interfaz: español (por defecto) e inglés. El idioma se cambia en Ajustes.
- Tema claro/oscuro: botón de luna/sol en la parte inferior de la barra lateral.

## 2. Roles de usuario
- ADMIN: acceso completo (campañas, creadores, marcas, integraciones, benchmarks, equipo, ajustes).
- EMPLOYEE: gestiona campañas, creadores, pipeline, listas, contactos. No gestiona integraciones ni benchmarks (solo ADMIN).
- BRAND (cliente): solo lectura. Vive confinado en el Portal de cliente (/portal); cualquier otra ruta le redirige al portal.
- CREATOR: dashboard propio simplificado (Mi Perfil, Mi Creator Score, Mi Valor de Mercado, Mis Campañas) y Ajustes.
Los usuarios se invitan desde Ajustes → Equipo (roles Admin, Employee o Brand). El invitado recibe un email con un enlace /invite/[token] para crear su contraseña.

## 3. Navegación (barra lateral) y qué hace cada página
Navegación principal:
- Inicio (/dashboard): saludo, KPIs globales (Campañas Activas, Total Influencers, Alcance Total, Engagement Medio), estado de campañas, estado de envíos, actividad reciente, accesos rápidos (Crear Campaña, Analizar Perfil, Buscar Creadores, Gestionar Listas). Aviso "Conecta tus cuentas" si no hay integraciones.
- Marcas (/brands): marcas/clientes. Crear marca (nombre, sitio web), asignar empleados ("Gestionar Empleados"), vincular un "Usuario Marca (solo lectura)" para que vea resultados en el portal, "Copiar link de conexión IG" (enlace para que el cliente conecte su Instagram Business sin tener cuenta), "Ver campañas".
- Campañas (/campaigns): listado con búsqueda, filtros por estado (activa / pausada / archivada) y tipo; KPIs (Campañas Activas, Perfiles Rastreados, Total Campañas, Media Encontrada). Botón "Nueva Campaña".
- Creadores (/discover): buscador de creadores con dos modos: "Base de datos" (búsqueda interna instantánea, ~10 s, por nombre/@usuario/bio, categoría, ciudad/provincia, país, seguidores, engagement mínimo, nivel de encaje con España) y "Buscar en vivo" (Apify: por @usuario o por categoría/hashtag, tarda 1-2 min). También "Pegar lista de handles" (detecta @usuarios o URLs pegados en bloque y los procesa con "Procesar todos"). Acciones por resultado: Ver perfil, Añadir a lista, Enriquecer perfiles.
- Pricing (/pricing): Calculadora de Precios independiente (no requiere campaña). Ver sección 9.
- Resultados (/compare): Comparar Campañas. Seleccionar 2 o 3 campañas y ver lado a lado: publicaciones, influencers, alcance, vistas totales, engagements, tasa de engagement, coste total, tiers de influencers.
- Metodología (/methodology): documentación de la metodología TKOC en 6 secciones desplegables: Planificar, Elegir, Pagar, Ejecutar, Medir y Métricas clave (definiciones y fórmulas de engagement rate, CPM, alcance, impresiones, EMV; etiquetas de publicidad "Colaboración pagada", "Contenido de marca").
Navegación secundaria:
- Listas (/lists): listas de creadores (crear, fijar, eliminar; alcance combinado, con email; exportar). Cada lista se abre en /lists/[id].
- Similares (/lookalikes): introduce un @handle de Instagram, TikTok o YouTube y obtiene creadores parecidos. Ver sección 10.
- Contactos (/contacts): CRM ligero de creadores con los que se ha trabajado (estado, notas, tags, teléfono, email). Se llena al añadir creadores a campañas y listas.
- Mi Base de Clientes (/client-base): ver sección 11.
- Pipeline (/pipeline): kanban global de todos los creadores de todas las campañas (filtrable por campaña) con los 8 estados. Arrastrar entre columnas cambia el estado.
- Ajustes (/settings): pestañas Perfil, Equipo, Integraciones, Benchmarks (solo ADMIN) y Facturación. Idioma y foto de perfil en Perfil.
Otras páginas sin entrada en la barra lateral:
- Analizar Perfil (/analyze): pega la URL o @handle de Instagram, TikTok o YouTube → estadísticas del creador (seguidores, engagement, medianas de likes/comentarios/vistas, desglose de contenido, frecuencia de publicación, mejor tipo de contenido, mejor hora, tendencia de engagement, calidad de audiencia), "Obtener Insights", "Buscar Similares", "Añadir a lista", "Tarjeta de Tarifas" (guardar tarifa estándar del creador).
- Ficha de creador (/creators/[id]).
- Calendario (/calendar): vista mensual de campañas por fechas.
- Knowledge Base (/knowledge-base): documento interno de referencia.
- Informe de campaña (/campaigns/[id]/report).
Notificaciones: campana en la parte inferior de la barra lateral (nuevos posts detectados, creadores añadidos, etc.).

## 4. Flujo de trabajo de una campaña (paso a paso para el PM)

### Paso 1 — Crear la campaña
Campañas → "Nueva Campaña" (/campaigns/new). Opcional: "Cargar desde plantilla" para pre-rellenar. Campos:
1. Marca / Cliente (opcional pero recomendado): selecciona la marca. Si no existe, "Crear una marca primero" en Marcas. La marca es lo que permite que el cliente vea la campaña en su portal.
2. Tipo de campaña: "Seguimiento de Influencers" (rastrea creadores concretos: posts, reels, stories), "Social Listening" (rastrea a todos los que mencionan la marca o hashtags) o "Campaña UGC" (gestión de creadores UGC, pagos y entrega de contenido, sin calculadora de CPM).
3. Objetivo de la campaña: Visibilidad/Awareness, Engagement/Interacción, Tráfico web, Conversión/Ventas, Contenido/UGC (o sin objetivo). El objetivo condiciona la evaluación de Inteligencia de Campaña y la Sugerencia de Creator Mix.
4. Nombre (ej. "Vileda Primavera 2026").
5. Cuentas de Marca Objetivo: @menciones (ej. @vileda.es) y #hashtags a rastrear. Se pueden añadir varios.
6. Plataformas: Instagram, TikTok, YouTube.
7. Filtro de País (opcional): solo rastrear contenido de creadores de ese país; vacío = mundial.
8. Tipo de pago: Campaña de Pago (los creadores cobran) o Campaña Gifted (reciben producto). Las UGC siempre son de pago.
9. Duración: Fecha de Inicio y Fecha de Fin, o "Siempre Activo" (sin fecha de fin). SOLO se captura contenido publicado dentro de estas fechas.
10. Brief (texto y adjuntos PDF/Word/Excel/imagen) — también se puede añadir después en la pestaña Planificar.
También existe el "Asistente de Campaña" (wizard de 4 pasos: objetivo → lo esencial → qué rastrear → revisar y lanzar) accesible desde el listado de campañas.
Después de crear, cualquier campaña puede guardarse como plantilla ("Guardar como plantilla") y editarse ("Editar Campaña" en la pestaña Aprender).

### Paso 2 — Añadir creadores (pestaña "Elegir")
Cada campaña (/campaigns/[id]) tiene 5 pestañas que siguen la metodología: Planificar, Elegir, Pagar, Ejecutar, Aprender.
Formas de añadir creadores a la campaña:
- Desde la propia pestaña Elegir: buscar por username en la base de datos, o "Añadir Creador UGC" pegando @handle o URL de perfil (se analiza el perfil con Apify y se añade).
- "Añadir varios" (botón en la pestaña Elegir, junto al buscador) — LA FORMA DE AÑADIR MUCHOS DE GOLPE A UNA CAMPAÑA: se abre un panel con "Pegar lista" (pega @usuarios o URLs de perfil de Instagram/TikTok/YouTube, uno por línea o separados por comas) y "O sube un CSV" (se usa la primera columna, o cualquier celda con @ o URL; la fila de cabecera se ignora). Opcional: "Plataforma (si la URL no la indica)". Hasta 200 creadores por tanda. Los que ya están en la base de datos se añaden al instante; los nuevos se analizan con Apify (de 3 en 3) y los repetidos se omiten. Al terminar muestra añadidos / omitidos / errores por handle.
- Desde Creadores (/discover): buscar en la base de datos interna o en vivo y usar "Añadir a..." → campaña o lista. "Pegar lista de handles" sirve para descubrir/analizar muchos perfiles a la vez.
- Desde Similares (/lookalikes) o Analizar Perfil: "Añadir a lista" / "Añadir a Campaña".
- Desde una Lista: los creadores de una lista se pueden mandar a una campaña con "Añadir a Campaña".
- Importación CSV de creadores: con "Añadir varios" dentro de la campaña. (El CSV de Mi Base de Clientes es para contactos de la marca, no para creadores.)
Cada creador añadido crea/actualiza automáticamente un Contacto en /contacts y dispara en segundo plano una captura inmediata de su contenido reciente (solo se guarda lo que cumple las reglas de la sección 5). Solo los creadores que son MIEMBROS de la campaña se rastrean.
En Elegir se ve por creador: seguidores, engagement, plataforma, Creator Score, estado del pipeline, fee acordado, toggles "Derechos Ads / Spark Ads" y "Exclusividad", email, portfolio, "Invitar a conectar" (envía al creador un enlace para conectar su Instagram profesional y obtener métricas reales), "Quitar de campaña".

### Paso 3 — Estados del pipeline (por creador dentro de la campaña)
8 estados, en este orden: Prospecto (PROSPECT) → Contacto (OUTREACH) → Negociando (NEGOTIATING) → Acordado (AGREED) → Contratado (CONTRACTED) → Envío (SHIPPING) → Publicado (POSTED) → Completado (COMPLETED).
Se cambian desde la pestaña Elegir (selector de estado), desde Ejecutar → Pipeline (kanban arrastrando) o desde el Pipeline global (/pipeline). Los creadores en estado Envío aparecen en Ejecutar → Envíos, donde se rellenan los datos de envío (nombre, dirección, ciudad, CP, país, teléfono, producto/SKU, cantidad) y se descarga el "CSV Envíos".

### Paso 4 — Pagar (pestaña "Pagar")
Introducir el "Fee Acordado (€)" de cada creador. La plataforma muestra Análisis de Pricing por Influencer: CPM real (fee / vistas medias × 1000) con semáforo verde/amarillo/rojo frente al CPM objetivo del tier, Deal Advisor (veredicto, rango de mercado, escenarios, tip de negociación), Señales de Riesgo, e Inversión Total. Requiere haber añadido creadores en Elegir. Las campañas UGC muestran pagos y "Contenido Entregado" en lugar de CPM.

### Paso 5 — Ejecutar: captura de contenido (pestaña "Ejecutar")
Sub-pestañas: Media (posts, reels, carruseles, vídeos, shorts capturados), Stories (stories de Instagram capturadas antes de que expiren a las 24 h), Pipeline (kanban) y Envíos.
Captura automática: el servidor ejecuta tareas periódicas (definidas en src/instrumentation.ts) mientras la app está desplegada:
- track: cada 6 horas — captura de posts de las campañas activas (Apify).
- stories: cada 6 horas — captura de stories de Instagram de los creadores de campañas activas.
- check-posts: cada 12 horas — detecta posts nuevos y envía notificaciones.
- meta-sync: cada 4 horas — sincroniza las cuentas de Instagram Business conectadas vía API oficial de Meta (gratis, sin consumir Apify).
- check-deletions: cada 24 horas — detecta posts borrados por el creador (cumplimiento).
- meta-token-refresh: cada 24 horas — renueva tokens de Meta que caducan en menos de 7 días.
- discovery: cada 12 horas — procesa la cola de descubrimiento de creadores.
Captura manual: botón "Rastrear Ahora" en la cabecera de la campaña (también en Planificar y Elegir). Escanea hashtags, menciones, perfiles de los miembros y stories; al terminar muestra "Rastreo completado: N posts encontrados, N stories". Requiere que la campaña esté ACTIVA y que Apify esté configurado. Hay una ventana de deduplicación de 3 horas: si un objetivo se rastreó hace menos de 3 h, se omite.
Captura automática por evento (sin pulsar nada): al añadir un creador a la campaña (individual o con "Añadir varios") y cada vez que su estado pasa a Acordado, Contratado, Envío, Publicado o Completado, la plataforma rastrea su contenido reciente en segundo plano y guarda solo lo que cumple las reglas de la sección 5.
"Añadir publicación por URL" (Ejecutar → Media): pega la URL de un post, reel o vídeo de un creador que sea MIEMBRO de la campaña; "Detectar desde la URL" identifica la plataforma; se descarga con Apify y se guarda con fuente "manual". Si la publicación está fuera de las fechas de la campaña o el autor no es miembro, se rechaza con un mensaje claro.
"Registrar Story" (Ejecutar → Stories): registra a mano una story de un miembro (influencer, fecha, vistas, alcance, respuestas y enlace opcional). Lo registrado a mano nunca lo elimina la revalidación.
"Revalidar contenido" (Ejecutar → Media): vuelve a comprobar todo el contenido de la campaña contra las reglas (miembro + fechas + etiqueta/mención de la marca) y DESVINCULA lo que no cumple. No borra nada: el post deja de contar en la campaña pero sigue en la base de datos. El contenido manual siempre se conserva. Devuelve "conservados / desvinculados".
Aviso "no tiene cuentas objetivo ni hashtags: no se capturará contenido": aparece en la cabecera cuando la campaña no tiene Cuentas de Marca Objetivo ni hashtags. Sin objetivos NO se captura nada; se añaden en "Editar Campaña".
Botón "Diagnóstico" (junto a Rastrear Ahora): abre el "Diagnóstico de captura" y muestra si Apify está configurado, miembros de la campaña, miembros con/sin contenido capturado, total de posts capturados, cuándo se rastreó por última vez cada miembro, y el historial de trabajos de rastreo (completados/fallidos). Es el primer sitio donde mirar cuando "no aparece contenido".
Filtros en Media: ordenar por Más Recientes, Más Likes, Más Comentados, Más Vistos, Más Compartidos, Más Guardados; filtrar por plataforma e influencer; "Cargar Más".
Sentimiento: en Aprender → Sentimiento, "Analizar Comentarios" escanea los comentarios de los posts de la campaña y clasifica positivo/negativo/neutro.
Cumplimiento: detecta posts eliminados y colaboraciones no declaradas (falta #ad / "Colaboración pagada") en campañas de pago.

### Paso 6 — Informe y exportación
- "Ver informe" (/campaigns/[id]/report): informe completo de la campaña (resumen, KPIs, evolución temporal, desglose por plataforma, niveles de influencers, contenido destacado, demografía si hay datos de Meta).
- "Exportar Informe": abre la vista previa editable (título, resumen, imagen de portada, notas, secciones que se muestran/ocultan) y exporta a PDF. La portada estándar aprobada lleva el logo de The King of Content y el logo/nombre de la marca de la campaña (se toma de la Marca asociada; si la campaña no tiene marca, solo aparece TKOC). También "Exportar PDF", "Exportar CSV" y "Exportar JSON" directos desde la cabecera.
- KPIs de Resumen: Likes Medios, Comentarios Medios, Vistas Medias, Vistas Totales, Tasa de Engagement = (likes + comentarios) / alcance (o vistas) × 100, Impresiones, Perfiles Publicados, Valor de Media (EMV). "EMV Básico" = solo audiencia (audiencia / 1000 × CPM); "EMV Ampliado" = audiencia + clics + engagement (fórmula TKOC).
- Cómo se calcula el EMV (decisión de David, sept. 2026): el CPM depende del tipo de contenido y se edita en Ajustes → Benchmarks → Tasas EMV. Valores actuales (Instagram): post 10 €, reel 14 €, story 8 €. Posts y reels usan SOLO datos reales (impresiones > alcance > vistas; nunca se estiman). Las STORIES de Instagram no tienen vistas públicas: si la story no tiene vistas reales, su audiencia se ESTIMA como seguidores de la creadora × porcentaje por tier (Nano < 10K: 15 %, Micro 10K-50K: 10 %, Mid 50K-250K: 7 %, Macro 250K-1M: 5 %, Mega > 1M: 4 %), y cada story consecutiva de la misma creadora (menos de 3 h de diferencia) vale un 15 % menos que la anterior. Ejemplo: creadora de 40.000 seguidores → 4.000 vistas estimadas → 4 × 8 € = 32 € por story; tres seguidas ≈ 82 €. Si la PM registra las vistas reales del pantallazo ("Registrar Story"), el dato real manda y además la herramienta aprende el ratio real de esa creadora (vistas ÷ seguidores) para sus siguientes stories. Los informes indican cuántas stories llevan audiencia estimada.

### Paso 7 — Portal de cliente (solo lectura)
Los usuarios con rol BRAND entran en /portal ("Portal de cliente"): ven las campañas de su marca (estado: En preparación, Activa, Pausada, Completada, Archivada), y dentro de cada una el contenido capturado (posts, reels, stories, carruseles), los creadores con su estado (Propuesto, Contactado, En conversación, Confirmado, Producto enviado, Publicado, Completado, Descartado) y el informe. No pueden editar nada ni rastrear.
Para dar acceso a un cliente: (1) crear la marca en Marcas, (2) asociar la campaña a esa marca al crearla, (3) en Marcas → "Usuario Marca (solo lectura)" vincular o invitar al usuario con rol Brand (Ajustes → Equipo → Invitar Miembro → rol Brand, y asignación de marca). Un ADMIN puede previsualizar el portal de una marca.

### Paso 8 — Aprender (pestaña "Aprender")
- Inteligencia de Campaña: puntuación según el objetivo elegido, señales semáforo y recomendaciones.
- Playbook — Qué hacer a continuación: creadores a repetir/evitar, formato con mejor rendimiento, dónde reasignar presupuesto.
- Sentimiento de comentarios.
- Editar Campaña, Guardar como Plantilla, Datos de Envío.

## 5. Reglas de captura de contenido (qué entra en una campaña y qué no)
0. Si la campaña no tiene Cuentas de Marca Objetivo ni hashtags, NO se captura nada (aviso en la cabecera). Primero hay que definir qué se rastrea.
1. Solo se captura contenido de creadores que son MIEMBROS de la campaña (añadidos en Elegir). Si un creador no está en la campaña, su contenido no se asocia aunque mencione a la marca.
2. Solo se captura contenido publicado DENTRO de las fechas de la campaña (desde Fecha de Inicio hasta el final del día de la Fecha de Fin, inclusive; sin fecha de fin = siempre activo). Posts anteriores al inicio no se asocian. El contenido sin fecha de publicación no se captura (no se puede demostrar que esté dentro de la ventana). Un mismo post cuenta en TODAS las campañas cuyas reglas cumpla (por ejemplo, en la campaña anual de contratos y en la mensual de ese mes): deciden la fecha y la pertenencia del creador, no el orden en que se capturó. En el dashboard global cada publicación se cuenta una sola vez.
3. El contenido debe estar relacionado con la marca: etiquetar/mencionar alguna de las Cuentas de Marca Objetivo (ej. @vileda.es) en el caption, las menciones o la etiqueta de colaboración, o usar alguno de los hashtags objetivo. Si el creador publica sin mencionar a la marca ni usar el hashtag, el post no se captura automáticamente.
4. Fuentes de datos, por prioridad: meta_api (API oficial de Meta, cuando la marca o el creador han conectado su Instagram Business; aporta alcance, impresiones, guardados y compartidos reales), apify (scraping público, fallback) y manual. Cada media registra su fuente.
5. Deduplicación: dentro de una campaña un post existe una sola vez (clave externalId + plataforma + campaña). Si Apify y Meta capturan el mismo post, se fusionan por el código corto del enlace y la fila conserva las métricas reales de Meta. El mismo post puede existir en varias campañas (una fila por campaña) y en los totales globales se cuenta una sola vez.
6. Filtro de país: si la campaña tiene país, se descarta el contenido de creadores que no encajan (heurística por bio, ubicación y ciudades para España).
7. Stories: solo Instagram; expiran a las 24 h. Dos vías: (a) rastreo automático cada 12 h SOLO de las creadoras en estado Acordado, Contratado, Envío, Publicado o Completado (el rastreo de stories se paga por story revisada, así que el PM DEBE marcar el estado cuando la creadora confirme; en Prospecto no se rastrean stories); (b) menciones en tiempo real vía Meta (Mensajería de Instagram): cuando una creadora menciona a @vileda.es con el sticker de una story, Instagram genera un mensaje "te ha mencionado en su story" y Meta avisa a la plataforma al instante; la story entra en la campaña sin coste, sea cual sea el estado de la creadora. Requiere que la cuenta de Instagram de la marca tenga activado "Permitir acceso a los mensajes" para la app (Configuración de Instagram → Privacidad → Mensajes → Herramientas conectadas) y que la creadora tenga cuenta pública (o siga a la marca). Las menciones en comentarios NUNCA cuentan como contenido de campaña. La story cuenta solo si menciona a la marca (sticker de mención o hashtag objetivo).
8. Las métricas por scraping (Apify) son públicas: likes, comentarios, vistas cuando el post las expone. Alcance, impresiones y guardados solo llegan con la conexión de Meta.

## 6. Conexión con Meta (Instagram Business) — Ajustes → Integraciones
- Botón "Conectar con Facebook" / "Conectar Instagram". Requisitos: cuenta de Instagram Profesional (Business o Creator) vinculada a una Página de Facebook, y permisos aceptados en el diálogo de Meta.
- Qué aporta: analíticas oficiales de posts, reels y stories (alcance, impresiones, guardados, compartidos), demografía de audiencia (edad, género, país, ciudad), y detección de menciones/etiquetas de marca en el contenido de los creadores sin capturas manuales.
- Permisos que pide la conexión de MARCA: instagram_basic, instagram_manage_insights, instagram_manage_comments, pages_show_list, pages_read_engagement, business_management. El permiso instagram_manage_comments es el que permite leer las publicaciones en las que los creadores ETIQUETAN a la marca (endpoint /tags); las conexiones hechas antes de añadirlo no lo tienen y hay que "Volver a conectar" (o reenviar a la marca el link de conexión IG) para que el contenido etiquetado entre en las campañas.
- Cada cuenta conectada se sincroniza automáticamente (cron meta-sync cada 4 h) y se puede "Sincronizar" manualmente. Estados: Conectado, Expirado (hay que "Volver a conectar"), Error, Desconectado. Los tokens se cifran en reposo (AES-256-GCM) y se renuevan automáticamente.
- Para que un CLIENTE conecte su Instagram sin cuenta en la herramienta: Marcas → "Copiar link de conexión IG" y enviárselo. El enlace caduca (30 días).
- Para que un CREADOR conecte su cuenta: en la campaña, pestaña Elegir → "Invitar a conectar" (email con enlace /creators/connect/[token]).
- Solo ADMIN gestiona integraciones. Otras integraciones en la misma pestaña: Apify (clave API, "Probar Conexión"), YouTube Data API v3 (clave API, datos públicos de canales y vídeos, sin OAuth), TikTok (OAuth configurado, pendiente de revisión de app). Prioridad de datos: APIs oficiales primero, Apify como fallback.

## 7. Apify (motor de scraping) y sus límites
- Apify se usa para: búsqueda en vivo de creadores, analizar perfiles, capturar posts/stories por scraping, hashtags y menciones, lookalikes por cuentas similares.
- Tiene una CUOTA MENSUAL de uso. Cuando Apify devuelve "Monthly usage hard limit exceeded", la plataforma activa un cortacircuitos: todas las llamadas a Apify fallan al instante hasta que se reinicia el ciclo mensual (la fecha se lee de la API de Apify). Mientras tanto: no funciona Buscar en vivo, Analizar Perfil de creadores nuevos, ni la captura por scraping; SÍ sigue funcionando todo lo que viene de la API de Meta (meta-sync) y los datos ya guardados.
- Señales de que está agotado: banner en Creadores (/api/apify-status), errores "APIFY_EXHAUSTED" en el Diagnóstico, trabajos de rastreo fallidos.
- Solución: esperar al reinicio del ciclo o ampliar el plan en Apify; y priorizar la conexión de Meta de la marca/creadores para no depender del scraping.
- Ventana de deduplicación de 3 h por objetivo para no gastar cuota repitiendo rastreos.

## 8. Sistema de inteligencia (qué significan los indicadores)
- Creator Score (0-100, grado A+ a F): Calidad de Engagement 30 %, Eficiencia de Valor (CPM vs. mercado) 25 %, Consistencia 20 %, Historial de colaboraciones 15 %, Calidad de Audiencia 10 %.
- Deal Advisor: veredicto sobre el fee (buen trato / justo / sobrepagado), rango de mercado, 3 escenarios (Conservador p25, Realista p50, Optimista p75), ahorro/sobrecoste, tip de negociación.
- Señales de Riesgo (7 categorías, niveles crítico/aviso/info): caída de engagement, picos sospechosos de seguidores, borrado de contenido post-campaña, falta de disclosure (#ad), CPM muy por encima del mercado, baja tasa de entrega, anomalía engagement/seguidores.
- Repeat Radar: por creador con historial, recomienda Repetir / Considerar / Descartar.
- Benchmark de Mercado: rangos de fees por plataforma, tier y formato (Post, Reel, Story, Vídeo, Short). Editables por ADMIN en Ajustes → Benchmarks (Rangos de Fees p25/p50/p75/p90, Umbrales CPM, Tasas EMV); pueden definirse por marca o usar los globales.
- Tiers por seguidores: Nano < 10K, Micro 10K-50K, Mid 50K-250K, Macro 250K-1M, Mega > 1M. (En la sugerencia de Creator Mix se agrupan como Micro < 10K, Mid 10K-100K, Macro 100K-1M, Mega > 1M.)
- Engagement: > 3 % bueno, > 5 % excelente; calidad de audiencia Alta > 3 %, Media 1-3 %, Baja < 1 %.
- Encaje con España (Spain Fit): "España confirmado", "España probable", "España parcial", "Hispano global" según bio, ubicación y señales.

## 9. Calculadora de Precios (/pricing)
Inputs: plataforma, seguidores, vistas medias (obligatorios; o un username para cargarlos "De BD"), fee que pide el creador, formato, y opcionales likes medios, comentarios, engagement rate.
Outputs: tier detectado, CPM real ("Coste por 1000 views") frente al CPM objetivo del mercado, semáforo, Rango de Mercado para ese tier, Escenarios de Precio (Conservador p25 / Realista p50 / Optimista p75) con "Ahorro / Sobrecoste", Recomendación, "Decisión Final" y Tip de negociación. Avisos por tier (Macro/Mega nunca solo gifting; Nano suele aceptar gifting). Usa los mismos algoritmos que Deal Advisor dentro de una campaña.

## 10. Similares (Lookalikes)
Introduce un @handle o la URL del perfil (instagram.com/usuario, tiktok.com/@usuario, youtube.com/@canal); la plataforma se detecta sola desde la URL. La plataforma toma el creador fuente (de la base de datos o analizándolo con Apify) y busca candidatos en la base de datos interna y, si Apify está disponible, en cuentas similares sugeridas por Instagram. Cada resultado tiene una puntuación de coincidencia con "Razones de coincidencia": categoría principal y categorías compartidas, similitud de seguidores, similitud de engagement, ubicación y marcas con las que ha trabajado. Desde el resultado: Ver perfil, Añadir a lista. Requiere Apify para buscar fuera de la base de datos.

## 11. Mi Base de Clientes y captura en vivo (/client-base)
- Contactos: importa clientes de la marca por CSV (con mapeo de columnas), manualmente o desde CRM (HubSpot/Apollo). Campos: nombre, email, empresa, dominio, teléfono, redes sociales, tipo de relación (cliente, lead, proveedor, partner, ex cliente, empleado), estado.
- Matches: el motor cruza los contactos con perfiles de creadores para encontrar "oportunidades warm": creadores que ya son clientes. Cada match tiene nivel de confianza (Exacto, Probable, Posible) y Warm Score con grado A-F (A ≥ 80, B ≥ 60, C ≥ 40, D ≥ 20) y tasa de respuesta esperada; se puede Confirmar o Rechazar.
- Capturas en Vivo y Widgets: crea un widget (nombre de marca, logo, color, textos, disparador: intención de salida / retardo / scroll / manual, dominios permitidos), copia el código de inserción (script antes de </body>) en la web de la marca, y captura los perfiles sociales de los visitantes; cada 4 h se enriquecen y se cruzan con creadores.

## 12. Ajustes → Equipo y otros
- Equipo: invitar por email con rol (Admin, Employee, Brand), cambiar rol, eliminar; "Brand Assignments" para asignar marcas a empleados.
- Benchmarks (ADMIN): rangos de fees, umbrales CPM y tasas EMV; "Restaurar Valores por Defecto"; selección de marca para benchmarks propios.
- Facturación: plan actual y uso (informativo).
- Plantillas de campaña: se crean desde una campaña ("Guardar como plantilla") y se cargan en Nueva Campaña.
- Notas de campaña por creador, Historial de colaboraciones previas de cada creador, Duplicados (creadores repetidos entre campañas).

## 13. Limitaciones conocidas y problemas frecuentes
- "No aparece contenido en la campaña": comprobar en este orden (0) la campaña tiene Cuentas de Marca Objetivo o hashtags (sin ellos no se captura nada); (1) el creador está en Elegir como miembro; (2) el post se publicó dentro de las fechas; (3) el post menciona/etiqueta la cuenta objetivo o usa el hashtag; (4) Diagnóstico → Apify configurado y sin cuota agotada; (5) pulsar "Rastrear Ahora" (si se rastreó hace < 3 h, se omite); (6) esperar al siguiente cron (6 h). Si la marca tiene Meta conectado, Sincronizar en Integraciones.
- Stories caducan a las 24 h: si no se capturan ese día, se pierden.
- Alcance, impresiones, guardados y demografía solo existen con conexión de Meta; con Apify solo métricas públicas (likes, comentarios, vistas cuando están expuestas).
- TikTok: la integración OAuth está pendiente de revisión de app; los datos de TikTok llegan por Apify. YouTube: datos públicos vía YouTube Data API (clave API).
- Apify tiene cuota mensual; al agotarse se detiene la búsqueda en vivo y el scraping hasta el nuevo ciclo.
- El asistente de IA (TKOC AI) NO ejecuta acciones en la plataforma: explica cómo hacerlas y analiza los datos que ve. No borra, crea ni edita nada.
- El portal de cliente es solo lectura; los usuarios BRAND no pueden rastrear ni editar.
- Solo ADMIN puede tocar Integraciones y Benchmarks.
`.trim()
