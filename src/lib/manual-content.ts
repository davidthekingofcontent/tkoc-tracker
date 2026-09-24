/**
 * Manual de usuario de TKOC Intelligence para las PMs (David, 2026-09-14).
 *
 * Es DATO, no diseño: la página /manual lo renderiza y `MANUAL_TEXT` (versión
 * compacta, ≤ 12.000 caracteres) se inyecta en el sistema del asistente TKOC AI
 * para que responda "qué tengo que hacer" con los pasos reales de la interfaz.
 *
 * Cada paso nombra la pantalla → pestaña → botón tal como está rotulado en la
 * interfaz en español (src/i18n/translations.ts y las páginas del dashboard).
 * Mantenerlo FACTUAL: si cambia un rótulo o una función, cambiar aquí. Las
 * definiciones de métricas son las de src/lib/ai-knowledge.ts (sección 5).
 */

export interface ManualTroubleshooting {
  problem: string
  doWhat: string[]
}

export interface ManualSection {
  id: string
  title: string
  summary: string
  /** Pasos numerados; cada uno nombra pantalla → pestaña → botón con su rótulo real. */
  steps: string[]
  tips?: string[]
  troubleshooting?: ManualTroubleshooting[]
}

export const MANUAL_SECTIONS: ManualSection[] = [
  {
    id: 'acceso',
    title: 'Qué es y cómo entrar',
    summary:
      'TKOC Intelligence es la herramienta interna de la agencia para llevar una campaña de influencer marketing de principio a fin: elegir creadores, cerrar el trato, capturar lo que publican, medirlo solo con datos reales y entregar el informe al cliente.',
    steps: [
      'Entra en https://intelligence.thekingofcontent.agency con tu email y contraseña. Si no tienes cuenta, un ADMIN te invita en Ajustes → Equipo → "Invitar Miembro"; recibes un email con un enlace para crear la contraseña.',
      'Roles: ADMIN (todo, incluidas Integraciones y Benchmarks; ve todas las campañas), EMPLOYEE (tú como PM: campañas, creadores, listas, contactos, informes; en Campañas, Inicio y Calendario ves solo las campañas que has creado o a las que te han dado acceso), BRAND (el cliente: solo lectura, confinado en /portal) y CREATOR (panel propio).',
      'Barra lateral: Inicio, Marcas, Campañas, Creadores, Pricing, Resultados, Metodología y Manual; debajo Listas, Similares, Contactos, Mi Base de Clientes, Pipeline y Ajustes. El idioma se cambia con el selector EN / ES de la barra superior (en todas las páginas); el tema claro/oscuro con el botón de luna/sol al pie de la barra.',
      'El botón "TKOC AI" (esquina inferior derecha) responde dudas de uso con estos mismos pasos y comenta las cifras de la campaña que le nombres (no sabe cuál tienes abierta). Solo lo ve el equipo; no ejecuta acciones ni edita nada: te dice cómo hacerlo tú.',
      'Notificaciones (campana al pie de la barra lateral): solo recibes los avisos de las campañas que has creado o a las que tienes acceso: creadores añadidos, notas, publicaciones detectadas, stories nuevas (un aviso por campaña), posts eliminados, creadores descubiertos y "Acceso a campaña" cuando te dan acceso. No hay avisos a todo el equipo ni de "campaña creada"; un ADMIN que no está en el equipo de una campaña tampoco recibe sus avisos. Las alertas de sistema (fallos de cron, pausas por presupuesto de Apify) llegan solo a los ADMIN.',
      'El cliente nunca entra aquí: su mundo es el portal (sección 9). Para darle acceso, Marcas → "Usuario Marca (solo lectura)".',
    ],
  },
  {
    id: 'crear-campana',
    title: 'Crear una campaña',
    summary:
      'Sin marca el cliente no verá nada en su portal; sin objetivo y sin al menos un objetivo numérico el servidor no crea la campaña; sin Cuentas de Marca Objetivo no se captura contenido.',
    steps: [
      'Campañas → "Nueva Campaña". Opcional: "Cargar desde plantilla" para pre-rellenar.',
      '"Marca / Cliente": elige la marca. Si no existe, "Crear una marca primero" te lleva a Marcas → "Crear Marca" (nombre y sitio web).',
      'Tipo: "Seguimiento de Influencers" (creadores concretos: posts, reels, stories), "Social Listening" (todo el que mencione a la marca) o "Campaña UGC" (producción de contenido, sin CPM).',
      '"Objetivo de la campaña" (obligatorio; opcional solo en Social Listening): Notoriedad, Engagement, Tráfico web, Conversión/Ventas o Contenido/UGC. Determina con qué números se juzga la campaña.',
      '"Objetivos numéricos": al menos uno mayor que 0 entre Vistas, Alcance, Interacciones, ER objetivo (%) y CPM máximo (€ por 1.000 vistas). La interfaz marca "Recomendado" según el objetivo. Si falta, el servidor responde "Selecciona un objetivo y al menos un objetivo numérico para crear la campaña."',
      '"Nombre de la Campaña" (ej. "Vileda Primavera 2026").',
      '"Cuentas de Marca Objetivo": las @menciones (ej. @vileda.es) y #hashtags que se rastrean. Puedes añadir varios. Sin ellos no se captura nada.',
      'Plataformas (Instagram, TikTok, YouTube); "Filtro de País" (opcional: vacío = mundial); "Campaña de Pago" o "Campaña Gifted".',
      '"Fecha de Inicio" y "Fecha de Fin", o "Siempre Activo". Solo se captura contenido publicado dentro de estas fechas.',
      'Brief: texto y adjuntos (PDF, Word, Excel, imagen); también después en la pestaña Planificar. Pide en el brief, como entregable, la captura de estadísticas de cada pieza a las 72 h (stories: antes de las 24 h).',
      '"Crear Campaña". Los objetivos se congelan al arrancar: a partir de ahí cada cambio en Aprender → "Editar Campaña" pide un motivo y queda en "Historial de cambios".',
      'Equipo de la campaña: la campaña la ven en su lista su creador y las personas con acceso (los ADMIN ven todas). Para que otra PM la vea y reciba sus avisos: cabecera de la ficha → "Equipo" (junto a "Rastrear Ahora" / "Informe (PDF)" / "Exportar") → se abre "Equipo de la campaña" con el equipo de la agencia → activa "Tiene acceso" en su fila; el creador sale marcado como "Creador". Solo el creador o un ADMIN pueden cambiarlo (los demás lo ven en solo lectura); la PM recibe el aviso "Acceso a campaña". Marcas → "Gestionar Empleados" → "Empleados Asignados" no da acceso a campañas, solo a la ficha de la marca.',
    ],
    tips: [
      'Desde el listado de Campañas también existe el Asistente de Campaña (5 pasos: Objetivo → Objetivos numéricos → Básicos → Tracking → Lanzar).',
      'Una campaña que repites cada mes: "Guardar como plantilla" en la cabecera de la ficha y cárgala en la siguiente.',
    ],
  },
  {
    id: 'creadores-trato',
    title: 'Añadir creadores y cerrar el trato',
    summary:
      'Todo ocurre en la pestaña Elegir de la ficha de campaña: quién está, en qué estado, a qué precio y con qué compromisos. El estado Acordado es el que activa el rastreo de stories, la línea base y la lista de prometido vs entregado.',
    steps: [
      'Ficha de campaña → Elegir: "Buscar por username..." añade uno de la base de datos; "Añadir Creador UGC" acepta @handle o URL de perfil y lo analiza; "Añadir varios" abre "Pegar lista" (un @usuario o URL por línea) u "O sube un CSV" (hasta 200 por tanda).',
      'Desde Creadores, Similares o Analizar Perfil no se añade a la campaña: "Añadir a..." y "Añadir a lista" solo añaden a una lista. Lleva esos creadores a la campaña desde Elegir ("Buscar por username..." o "Añadir varios") o desde su ficha → "Anadir a campana".',
      'Cada creador añadido crea o actualiza su Contacto y dispara en segundo plano una captura de su contenido reciente (solo se guarda lo que cumple las reglas de captura).',
      'Estado del pipeline (selector en la fila del creador): Prospecto → Contacto → Negociando → Acordado → Contratado → Envío → Publicado → Completado. También arrastrando en Ejecutar → Pipeline o en el Pipeline global.',
      'Pon Acordado en cuanto la creadora confirme. Desde Acordado (o posterior): se rastrean sus stories cada 12 h, se congela su línea base, cuenta entre los "creadores acordados" de Prometido vs entregado y su fee alimenta los benchmarks propios. En Prospecto no se rastrean stories.',
      '"Fee solicitado (€)": lo que pidió antes de negociar. "Fee Acordado (€)": lo cerrado; es el coste del creador en todas las métricas (CPM, Ratio EMV). "Formato": el negociado (Instagram Post / Reel / Story, TikTok Vídeo, YouTube Integración / Dedicado / Short); fija la celda de benchmark y la familia de la línea base.',
      '"Entregables comprometidos": número de piezas pactadas. "Enlace con UTM" y "Clics": el enlace del creador y los clics que registres. La ficha muestra "Entregados N / M" en verde cuando se alcanzan.',
      'En la misma fila: toggles "Derechos Ads / Spark Ads" y "Exclusividad", email y portfolio, "Invitar a conectar" (le envía un enlace para conectar su Instagram y dar métricas reales) y "Quitar de campaña".',
      'Pagar → "Análisis de Pricing por Influencer": benchmark del fee (p25 "Buen precio", p50 "Precio de mercado", p75 "Máximo justificable", p90 "Excepcional"), CPM por formato × tier con semáforo, EMV esperado, modificadores comerciales, Deal Advisor e "Inversión Total". Si no hay nadie avisa: Añade influencers en la pestaña "Elegir" primero.',
      'Línea base ("su habitual"): se congela sola al pasar a Acordado (últimas 12 publicaciones del mismo formato, mínimo 6). Si aparece "Sin línea base", "Introducir línea base" → Formato, Vistas medianas, Interacciones medianas, n (opcional) → guardar; "Borrar" la deja pendiente.',
    ],
    tips: [
      'Los seguidores solo eligen el tier; el precio se juzga sobre las vistas medianas del formato. Todo en euros sin IVA ni comisión.',
      'Pricing (barra lateral) es la misma calculadora sin necesidad de campaña.',
    ],
  },
  {
    id: 'envios',
    title: 'Envíos y direcciones',
    summary:
      'La dirección se pide una vez: al guardar un envío queda en Contactos y el siguiente envío de esa creadora se rellena solo.',
    steps: [
      'En Elegir cambia el estado del creador a Envío. Aparece en Ejecutar → Envíos.',
      'Ejecutar → Envíos → "Añadir envío" (o "Editar envío") abre el modal "Datos de Envío": Nombre destinatario, Dirección, Dirección 2 (opcional), Ciudad, Código Postal, País, Teléfono, Email, Producto / SKU, Cantidad, Comentarios. No todos son obligatorios.',
      'Si la creadora ya tiene dirección en Contactos, el modal se rellena solo y muestra "Dirección guardada en Contactos el {fecha}" (y "editada a mano" si la corrigió alguien). Revísala y "Guardar Datos".',
      'Al guardar, la dirección se copia automáticamente a Contactos con fuente "de un envío". No hay que teclearla dos veces.',
      '"Descargar CSV Envíos" genera el fichero para el transportista con todos los envíos de la campaña.',
      'Para corregir una dirección fuera de la campaña: Contactos → columna Dirección → "Editar dirección". La calle es obligatoria; vacía todos los campos para borrarla.',
    ],
  },
  {
    id: 'capturar',
    title: 'Capturar contenido',
    summary:
      'La captura es automática si se cumplen tres reglas: el creador es miembro de la campaña, la publicación está dentro de las fechas y menciona una Cuenta de Marca Objetivo o un hashtag. Lo que solo ve el creador (alcance, guardados, vistas de stories) entra con "Registrar estadísticas".',
    steps: [
      'Automático, sin pulsar nada: posts cada 6 h (Apify); cuentas de Meta conectadas cada 2 h (traen las publicaciones donde el creador etiqueta a la marca; los reels entran con 0 vistas y la plataforma completa las vistas con el dato público); borrados cada 24 h; además una captura inmediata al añadir un creador o al pasarlo a Acordado o posterior.',
      'Reglas: miembro de la campaña + fecha dentro del periodo + menciona/etiqueta una Cuenta de Marca Objetivo o usa un hashtag objetivo. Si la cabecera avisa "no tiene cuentas objetivo ni hashtags: no se capturará contenido", añádelos en "Editar Campaña".',
      '"Rastrear Ahora" (cabecera de la ficha): captura manual de hashtags, menciones, perfiles y stories. También aparece en Planificar, Elegir y en Media y Stories cuando están vacíos. Requiere campaña activa y Apify configurado; se ejecuta siempre que lo pulsas y gasta cuota de Apify (la ventana de 3 h solo existe en el rastreo automático). Al terminar: "Rastreo completado" con "N posts encontrados, M influencers encontrados".',
      'Stories de Instagram: caducan a las 24 h. Se escanean cada 12 h, en UNA sola ejecución para todas las creadoras en Acordado o superior de las campañas activas dentro de fechas y de 62 días o menos (las largas no se escanean: se paga por cuenta). Las menciones con sticker llegan al instante vía Meta si la marca tiene conectado su Instagram. Las stories de un periodo en que el rastreo estuvo pausado no se recuperan: solo se registran a mano con la captura de la creadora.',
      'Presupuesto de Apify: el rastreo automático (stories cada 12 h, publicaciones cada 6 h) funciona hasta que Apify llega al 95 % del plan mensual; la búsqueda externa de creadores ("Buscar más en Apify") se pausa antes, al 85 % (o al límite fijado por el administrador). Cuando algo se pausa, los ADMIN reciben un aviso "…pausado por presupuesto de Apify" (una vez al día) con la fecha del nuevo ciclo, la pestaña Stories muestra el aviso con esa fecha y Creadores muestra "pausada por presupuesto hasta el dd/mm". Nunca se muestran importes. Ya no existe el límite fijo que paraba las stories sin avisar (incidente del 9 al 24 de septiembre de 2026). Las acciones manuales (analizar un perfil, "Añadir publicación por URL") no se pausan.',
      'Ejecutar → Media → "Añadir publicación por URL": pega la URL, "Detectar desde la URL" y "Añadir publicación". El creador debe ser miembro y la fecha estar dentro de la campaña; si no, se rechaza con un mensaje. También acepta el enlace de una story (instagram.com/stories/usuario/…): la fecha se lee del propio enlace y no se consulta Apify; el formulario cambia a Vistas y Alcance (Likes y Comentarios no aplican a una story): tecléalos de la captura de la creadora o complétalos después con "Registrar estadísticas". Si la fecha no se puede leer del enlace, aparece el campo "Fecha de publicación" (obligatorio). Los destacados (highlights) no valen.',
      'Ejecutar → Stories → "Registrar Story" para anotar a mano una story: Influencer, Vistas, Alcance, Respuestas, Enlace (si pegas el enlace la fecha se lee sola), "Fecha de publicación" (opcional; obligatoria si la campaña ya terminó) → "Guardar Story". Las vistas de una story nunca son públicas: tecléalas de la captura de la creadora; una story manual no se enriquece con Apify. Si algo falla, el formulario muestra el motivo (creadora fuera de la campaña, fecha fuera del periodo, enlace de otra creadora). El dato manual manda y nunca lo borra la revalidación.',
      '"Registrar estadísticas" (en cada publicación y story de Ejecutar → Media y Stories): arrastra o pega la captura de la pantalla Estadísticas/Insights que te manda la creadora → "Leer con IA" → revisa las cifras (Alcance, Reproducciones, Guardados, Compartidos…) → guardar. Queda "Estadísticas del creador ✓ fecha" y sus cifras pasan a ser dato real. Sin captura, teclea los valores a mano.',
      '"Etiquetas" en cada publicación: Enfoque (Problema / solución, Tutorial, Unboxing, Testimonio, Humor, Comparativa, Día a día, Otro), Gancho (3 primeros segundos) y Beneficio de producto. Opcionales; sirven para los aprendizajes, no cambian métricas.',
      '"Revalidar contenido" (Ejecutar → Media): vuelve a pasar las reglas y desvincula lo que no cumple. No borra nada; lo manual se conserva. Al terminar informa: "N contenidos mantenidos, M desvinculados por no cumplir las reglas (miembro + fechas + menciona a la marca)".',
      'Publicaciones borradas por el creador: se marcan "Eliminado por el creador", siguen en los totales y se cuentan aparte. Nunca desaparecen en silencio.',
      'En Media puedes ordenar por Más Recientes, Más Likes, Más Comentados, Más Vistos, Más Compartidos, Más Guardados; filtrar por Plataforma e Influencer; "Cargar Más".',
    ],
  },
  {
    id: 'datos-reales',
    title: 'Datos reales y definiciones',
    summary:
      'Una sola definición para toda la plataforma: ficha, informe, portal, exportación e Inicio salen del mismo cálculo. Un dato que no existe no se muestra; nunca se rellena con estimaciones.',
    steps: [
      'Interacciones = likes + comentarios + compartidos + guardados. Siempre las cuatro.',
      'Vistas ≥ likes: las vistas de una publicación solo cuentan como dato real si son al menos iguales a sus likes. Si están por debajo, la cifra es parcial: la publicación queda "sin dato real" y el enriquecimiento la vuelve a consultar.',
      'Tasa de engagement = interacciones ÷ vistas reales × 100, de las mismas publicaciones (las que tienen vistas). Se publica solo con al menos 3 publicaciones con vistas, 500 vistas y un ratio de 100 % o menos; si no, "Muestra real insuficiente". Nunca sobre seguidores, alcance ni estimaciones.',
      'Audiencia real = suma por publicación de alcance real → si no, impresiones → si no, vistas reales. La audiencia estimada (stories y publicaciones sin datos, por tramo de seguidores) es informativa y solo de agencia: nunca aparece en el informe ni en el portal, ni entra en ER, CPM u objetivos.',
      'Coste = fee acordado (si no hay, el coste registrado). CPM real = coste ÷ vistas reales × 1.000; sin coste o sin vistas no hay CPM. Es interno.',
      'EMV: el cliente ve UNA cifra rotulada exactamente "EMV" con un "?" que explica "Valor equivalente en medios pagados de la audiencia y las interacciones conseguidas, a tarifas de mercado por plataforma y formato; incluye las stories". Reels y vídeos se valoran con sus vistas reales (valor por vista fijado en Ajustes; si es 0, CPM) más las interacciones; las stories sin vistas, con seguidores × % por tier. Nunca se escribe "estimado" junto al EMV.',
      'Solo agencia (el cliente no lo ve nunca): fees, coste, CPM, EMV Básico, Ratio EMV (EMV ÷ coste, "×2,4", nunca "ROI"), audiencia estimada, impresiones, Balance de campaña, CPA y ROAS, Deal Advisor y benchmarks.',
      'Qué es real hoy: likes, comentarios y vistas de reels y vídeos (dato público). Alcance, impresiones, guardados, compartidos y vistas de stories solo los tiene el creador: llegan con "Registrar estadísticas" (fuente "Estadísticas del creador"), con su cuenta conectada ("Invitar a conectar", fuente "Cuenta del creador") o tecleados ("manual"). Posts de imagen, carruseles y stories no tienen vistas públicas.',
      'Si la ficha y el informe muestran cifras distintas es porque ocultaste publicaciones o creadores en el informe (sus totales se recalculan sin ellos). Cualquier otra diferencia es un error que hay que reportar.',
    ],
  },
  {
    id: 'objetivos-negocio',
    title: 'Objetivos y resultados de negocio',
    summary:
      'Los objetivos numéricos se juzgan con datos reales y tolerancia ±10 %. Las ventas, leads y códigos son datos del cliente: se registran tal cual y nunca se derivan del EMV.',
    steps: [
      'Ficha → pestaña Planificar → bloque "Resumen" → "Objetivos de campaña": KPI · Objetivo · Resultado · Variación. Veredictos: "En objetivo" (±10 %), "Por encima del objetivo", "Por debajo del objetivo", "Sin datos" (p. ej. alcance sin ninguna publicación con dato real). En CPM máximo menos es mejor; esa fila el cliente no la ve.',
      'Resultado de cada KPI: Vistas = vistas reales; Alcance = audiencia real; Interacciones; ER = tasa sobre vistas; CPM = CPM real. Un objetivo no fijado no aparece.',
      'Cambiar un objetivo a mitad de campaña: Aprender → "Editar Campaña" → objetivos numéricos → campo "Motivo del cambio" → guardar. Queda en "Historial de cambios" (fecha, quién, valor anterior y nuevo).',
      'Planificar → bloque "Resumen" → "Resultados de negocio (aportados por el cliente)": Código promocional, Canjes del código, Ventas, Leads, Ingresos (€), Fuente (p. ej. "Informe Shopify del cliente, GA4…"), Fecha del dato, Notas y "ROI (dato del cliente)". Si no rellenas nada, la sección no aparece ni en la ficha ni en el informe.',
      'CPA por venta, CPA por lead y ROAS se calculan solos si hay coste y son solo de agencia. El cliente ve sus propios datos con el aviso "Cifras facilitadas por el cliente; la agencia no las verifica de forma independiente".',
      'Los clics de tráfico se registran por creador en Elegir ("Enlace con UTM" → "Clics"), no aquí.',
    ],
  },
  {
    id: 'informe',
    title: 'El informe',
    summary:
      'Un solo informe: la pantalla /campaigns/[id]/report es lo que ve el cliente y el PDF es idéntico a esa pantalla menos los bloques de agencia. Sin tocar nada, el informe estándar ya sirve; "Editar informe" es para ajustar.',
    steps: [
      'Cabecera de la ficha → "Informe (PDF)". Se abre el informe: portada con logos, "Resumen ejecutivo" (Vistas reales, Interacciones, Tasa de engagement, Audiencia real, Creadores, Publicaciones, "EMV" con "?"; tabla "Objetivos"; "Prometido vs entregado"; y, solo en tu pantalla, el "Balance de la campaña"), "Contenidos destacados", "Creadores", "Qué dijo la audiencia", "Aprendizajes y próximos pasos", "Datos: qué es real" (solo en tu pantalla) y "Anexo".',
      '"Editar informe" (barra superior; solo agencia, nunca se imprime): Título, Subtítulo, Introducción (bajo «Resumen ejecutivo») y Conclusiones y próximos pasos. Los cambios se previsualizan en vivo hasta guardar.',
      'Ocultar cosas: en "Editar informe", "Secciones — Ocultar al cliente" (cualquier sección) y "Columnas y tarjetas — Ocultar al cliente" (p. ej. "Creadores · Coste y CPM (interno; nunca en el PDF ni en el portal)"). En las tablas de Creadores y del Anexo, el icono "Ocultar esta fila al cliente" marca la fila "Oculto al cliente"; los totales se recalculan sin ella. "Volver a mostrar al cliente" lo deshace.',
      '"Prometido vs entregado": cuatro filas calculadas por el sistema — "Creadores que han publicado" (de los que están en Acordado o superior), "Piezas publicadas" (frente a los entregables comprometidos), "Publicadas dentro del periodo de campaña" e "Identificación legal". Cada una en Modo "Automático" o "Manual"; en Manual fijas Prometido, Entregado, Estado ("Cumplido" o "En revisión") y una Nota corta; un campo en blanco conserva el valor calculado.',
      '"Compromisos adicionales" → "Añadir compromiso" (hasta 4 filas propias, p. ej. «Derechos de uso · 12 meses»). Al cliente solo le llegan las filas "Cumplido": una fila "Revisar" o "En revisión" no sale ni al portal ni al PDF (nunca un verde falso). Para que salga en verde: entregables comprometidos por creador, fechas de campaña, creadores en Acordado o superior y #publicidad en los textos.',
      '"Identificación legal" cuenta publicaciones de feed (stories fuera) cuyo texto lleva #publicidad, #publi, "Publi", "colaboración pagada", #ad (y variantes como #patrocinado o "contenido patrocinado") o la etiqueta de colaboración pagada de la plataforma.',
      '"Qué dijo la audiencia": en "Editar informe" → "Comentarios destacados" → "Añadir comentario" (Texto del comentario, Autor (usuario), Tono positivo / neutro / negativo; hasta 12 de 300 caracteres) → "Quitar comentario" para eliminar. La sección se oculta sola si no hay comentarios destacados ni 20 comentarios analizados.',
      '"Marcar como enviado" → nota opcional → "Confirmar envío": registra "Versión N enviada el {fecha}" y quién la marcó. Así sabes qué vio el cliente y cuándo.',
      '"Descargar PDF": el servidor genera el PDF en A4 (se abre en una pestaña nueva). Es siempre la versión cliente: idéntica a la pantalla, sin Balance, "Datos: qué es real", fees, coste, CPM ni Ratio EMV y sin las filas ocultas ni las promesas no cumplidas. "Imprimir" abre el diálogo del navegador y queda como acción secundaria. "Volver" regresa a la ficha.',
    ],
    tips: [
      'Los datos (no el informe) se exportan desde la ficha: menú "Exportar" → "Exportar CSV" / "Exportar JSON".',
      'La sección "Aprendizajes y próximos pasos" se genera sola desde los mismos datos; el bloque "Solo agencia" (Nota, Menor rendimiento, A revisar, Presupuesto) no se imprime ni llega al portal.',
    ],
  },
  {
    id: 'portal',
    title: 'Portal del cliente',
    summary:
      'El usuario BRAND vive en /portal y solo lee. Ve el mismo informe que tú con lo que hayas ocultado y sin ninguna cifra económica.',
    steps: [
      'Dar acceso: (1) la campaña tiene "Marca / Cliente"; (2) Marcas → "Usuario Marca (solo lectura)" → vincula un usuario existente o invítalo (rol Brand). Para conectar su Instagram sin cuenta: Marcas → "Copiar link de conexión IG".',
      'Ve: sus campañas con estado ("En preparación", Activa, Pausada, Completada, Archivada); dentro de cada una, el contenido capturado (los borrados, marcados), los creadores con estado en su lenguaje (Propuesto, Contactado, En conversación, Confirmado, Producto enviado, Contenido entregado, Publicado, Completado), vistas, interacciones, audiencia real, tasa de engagement sobre vistas ("Muestra real insuficiente" cuando no se puede publicar), entregables comprometidos, "EMV" con su "?", la tabla de objetivos sin la fila de CPM, los resultados de negocio que él mismo aportó y los aprendizajes en versión cliente.',
      '"Ver informe completo" abre el mismo informe en modo portal, con las filas cumplidas de "Prometido vs entregado" y su propio "Descargar PDF".',
      'No ve nunca: fees, coste, CPM (ni el objetivo de CPM máximo), Ratio EMV, EMV Básico, CPA, ROAS, audiencia estimada, impresiones, Balance, benchmarks, Deal Advisor, la nota de campaña, el peor creador ni el consejo de presupuesto. No puede rastrear, editar ni cambiar estados.',
      'Si te pregunta por el "retorno": en su lenguaje la respuesta es el EMV (sin llamarlo estimación) y, si los aportó, sus propios resultados de negocio.',
    ],
  },
  {
    id: 'aprender',
    title: 'Aprender',
    summary:
      'La pestaña Aprender y la sección de aprendizajes del informe salen de los mismos datos que el resumen: si no hay dato real, no hay aprendizaje, y lo dicen.',
    steps: [
      'Ficha → Aprender → "Inteligencia de Campaña": puntuación según el objetivo elegido, señales semáforo y recomendaciones.',
      'Aprender → "Playbook — Qué hacer a continuación": "Nota de campaña", "Ratio EMV", "Conclusiones clave", creadores a "Repetir" y a "No repetir la próxima vez", "Mejor rendimiento", "Rendimiento por formato" (Mejor / Más flojo), "Consejo de presupuesto" y "Siguiente campaña".',
      '"Sin vistas reales" en el Playbook: creadores con contenido pero sin vistas reales (vistas al menos iguales a sus likes, mínimo 500). No se juzgan; pide sus estadísticas y regístralas antes de valorarlos.',
      'En el informe, "Aprendizajes y próximos pasos": "Claves" (qué funcionó), "Qué repetir" (creadores a repetir; "Todavía no destaca ningún creador" cuando no hay dato real suficiente), "Mejor rendimiento" (el creador con mejor resultado real), "Formato ganador" ("Se usó un único formato: no hay comparación posible" si solo hubo uno) y "Siguiente oleada" (la recomendación para la próxima campaña, redactada para el cliente).',
      'El bloque "Solo agencia" (Nota, Menor rendimiento, A revisar, Presupuesto, "Decisiones acordadas") no se imprime ni llega al portal.',
      'Sentimiento: no hay pantalla ni botón para analizar comentarios. El porcentaje de positivos solo sale en el informe con 20 o más comentarios analizados en la base de datos; hoy la sección "Qué dijo la audiencia" vive de los comentarios que destacas a mano en "Editar informe".',
    ],
  },
  {
    id: 'contactos-listas',
    title: 'Contactos, listas y creadores',
    summary:
      'Contactos se llena solo; las listas son tu cesta antes de la campaña; Creadores, Similares y Analizar Perfil son las tres formas de encontrar gente.',
    steps: [
      'Contactos: CRM ligero que se rellena automáticamente al añadir creadores a campañas y listas (nombre, email, Teléfono, Dirección, Añadido). Busca con "Buscar contactos..."; la dirección se corrige con "Editar dirección".',
      'Listas → "Crear nueva Lista". Dentro de una lista: "Eliminar de la lista" y fijar la lista (aparece en la barra lateral). No hay "Añadir a Campaña" y el botón "Exportar" todavía no hace nada: para llevar sus creadores a una campaña, usa Ficha de campaña → Elegir ("Buscar por username..." o "Añadir varios") o la ficha del creador → "Anadir a campana".',
      'Creadores → "Base de datos": búsqueda interna instantánea y sin Apify. Solo muestra creadores con datos reales (seguidores > 0, normalmente con bio y foto); los perfiles vacíos que se crearon en abril desde hashtags ya no aparecen. Filtros: texto, plataforma, categoría, ciudad, seguidores y encaje con España. Ya no existe el aviso ámbar de "Ejecuta el enriquecimiento". Por resultado: "Ver perfil" y "Añadir a..." (elige una lista; no añade a campañas).',
      'Creadores → "Buscar en vivo": "Por @usuario" analiza ese perfil con Apify (~10 s). "Por categoria" busca primero GRATIS en nuestra base (categoría asignada, palabras de la bio o nombre; solo creadores con datos reales) y muestra el recuento "De nuestra base de datos"; debajo, "Buscar más en Apify" abre una confirmación sin cifras de coste → "Sí, buscar en Apify" o "Cancelar". Al confirmar lanza una única búsqueda de publicaciones recientes del hashtag de la categoría, completa los autores nuevos con sus datos de perfil en esa misma ejecución y guarda el resultado 7 días (repetirla no consume). Al 85 % del plan mensual de Apify (o al límite fijado por el administrador) esta búsqueda externa se pausa: el botón no aparece y Creadores muestra "pausada por presupuesto hasta el dd/mm", sin cifras; la base de datos sigue funcionando. "Pegar lista de handles" → "Procesar todos" analiza muchos perfiles de golpe.',
      'Todo creador que se analiza o captura entra solo en la base de datos con su categoría. Las categorías se asignan automáticamente desde la bio, los hashtags y las menciones/marcas de las publicaciones capturadas, con coincidencia por palabra completa (antes "Ashley" contaba como "ley"); no hay ningún botón de enriquecimiento que pulsar.',
      'Analizar Perfil (/analyze): pega la URL o @handle → "Analizar" → estadísticas, "Obtener Insights", "Buscar Similares" (mismo motor que Similares), "Añadir a lista", "Tarjeta de Tarifas" (tarifa estándar).',
      'Similares: introduce un @handle o URL → "Buscar Similares" → candidatos de nuestra base de datos (solo creadores con datos reales): primero los de afinidad temática (misma categoría principal, categorías en común, marcas en común, palabras clave de la bio) y después los marcados "Audiencia comparable (sin afinidad temática confirmada)". Si el creador fuente no tiene categoría asignada, todos salen marcados "Audiencia comparable (el creador fuente no tiene categoría asignada)": analízalo en Analizar Perfil o en "Por @usuario" para que reciba categoría y repite la búsqueda. Cada tarjeta muestra sus "Razones de coincidencia" → "Ver perfil" / "Añadir a lista" (elige una lista; si el creador aún no tiene ficha, se analiza primero con Apify y después entra en la lista). Solo usa Apify para eso y para analizar un creador fuente que no esté en la base; la antigua sugerencia "Sugerido por Instagram" ya no existe porque Instagram no devuelve esos datos.',
      'Ficha de creador (/creators/[id]): perfil con "Anadir a lista" y "Anadir a campana", desglose Spain Fit, Rendimiento, relación previa con clientes, Posts recientes, Menciones de marcas, Señales geográficas e Historial de crecimiento.',
    ],
    tips: [
      'Solo ADMIN: POST /api/admin/sync-creator-pool reconstruye o actualiza la base de creadores a partir de los influencers con datos. Se ejecuta una vez tras el despliegue y después es automático; una PM no tiene que hacer nada.',
      'Las búsquedas no muestran cifras de coste de Apify: es intencionado, no un error.',
    ],
  },
  {
    id: 'ajustes',
    title: 'Ajustes',
    summary:
      'Perfil, Equipo, Integraciones, Benchmarks (solo ADMIN) y Facturación. Lo único que una PM toca a diario es Perfil; el resto lo cambia David.',
    steps: [
      'Ajustes → Perfil: nombre, empresa, foto ("Subir avatar") y tema claro/oscuro. El idioma no está aquí: selector EN / ES de la barra superior.',
      'Ajustes → Equipo → "Invitar Miembro" → email y Rol (Admin, Employee o Brand) → "Enviar Invitación". Es la forma de dar de alta al equipo y a los clientes; los creadores (rol Creator) se registran solos en /creators/register. Aquí también se cambia el rol, se elimina y se asignan marcas a empleados, pero eso no cambia lo que ve la PM: la ficha de la marca se da en Marcas → "Gestionar Empleados" → "Empleados Asignados"; el acceso a una campaña, en su ficha → "Equipo" → "Tiene acceso".',
      'Ajustes → Integraciones (solo ADMIN): Apify ("Clave API", "Probar Conexión"), Meta / Instagram ("Connect with Facebook" o "Conectar Instagram" para conectar, "Reconnect" si ya hay conexión, "Sincronizar" por cuenta; estados Conectado, Expirado, Error, Desconectado), YouTube Data API y TikTok (pendiente de revisión).',
      'Ajustes → Benchmarks → "Tasas EMV": "Tasas CPM (por 1.000 de audiencia)" por plataforma y formato (hoy Instagram post 10 €, reel 14 €, story 8 €; TikTok vídeo 8 €; YouTube vídeo 15 €, short 8 €), valores por interacción, "Stories: audiencia estimada (% de seguidores)" por tier con su decaimiento, "Publicaciones: alcance estimado (% de seguidores)", "Valor por vista (reels y vídeos)" (€ por vista real; 0 = usar el CPM; hoy 0,05 € en reels) y "Multiplicador de confianza" (×1 = apagado, que es como está; si se activa, el "?" del EMV se lo dice al cliente). "Restaurar valores por defecto" y Guardar.',
      'El resto de Benchmarks (rangos de fees p25-p90, CPM aceptable por formato × tier, multiplicadores por país, modificadores comerciales) está cerrado con la semilla SPAIN 2026 v1 y se mezcla solo cada mes con las negociaciones propias. No lo toques sin David.',
      'Ajustes → Facturación: plan y uso, informativo.',
    ],
  },
  {
    id: 'que-hacer-si',
    title: 'Qué hacer si…',
    summary:
      'Los problemas de cada día, en orden de comprobación. Si después de esto sigue igual, pregunta a TKOC AI nombrando la campaña o avisa a David.',
    steps: [
      'Antes de nada comprueba las tres reglas de captura (miembro, fechas, mención) y que la campaña está activa.',
      'Después, el estado de Apify (banner en Creadores y aviso de pausa por presupuesto en la pestaña Stories) y de las cuentas de Meta (Ajustes → Integraciones).',
      'Si el dato que falta es alcance, guardados o vistas de stories, la solución casi siempre es "Registrar estadísticas" con la captura de la creadora.',
    ],
    troubleshooting: [
      {
        problem: 'Una creadora no muestra publicaciones',
        doWhat: [
          'Ficha → cabecera: ¿hay "Cuentas de Marca Objetivo" o hashtags? Si sale el aviso, añádelos en "Editar Campaña".',
          'Elegir: ¿está como miembro de la campaña? Si no, añádela.',
          '¿La publicación está dentro de "Fecha de Inicio" / "Fecha de Fin" y menciona a la marca o usa el hashtag? Si no, no entra sola: Ejecutar → Media → "Añadir publicación por URL".',
          'Creadores: ¿hay banner de Apify agotado, o la pestaña Stories avisa de una pausa por presupuesto? Entonces espera a la fecha del nuevo ciclo que indica el aviso o usa Meta.',
          '"Rastrear Ahora" (se ejecuta siempre y gasta cuota de Apify) o espera al siguiente ciclo de 6 h. Con Meta conectado, Ajustes → Integraciones → "Sincronizar".',
        ],
      },
      {
        problem: 'La tasa de engagement dice "Muestra real insuficiente"',
        doWhat: [
          'Faltan publicaciones con vistas reales: hacen falta al menos 3, 500 vistas y un ratio plausible. Posts de imagen, carruseles y stories no tienen vistas públicas.',
          'Pide a cada creadora la captura de estadísticas de sus piezas y regístrala con "Registrar estadísticas" (Ejecutar → Media / Stories).',
          'O que conecte su cuenta: Elegir → "Invitar a conectar". Para stories, "Registrar Story" con sus vistas reales.',
          'Nunca se rellena con estimaciones: el "—" es la respuesta correcta hasta que haya dato.',
        ],
      },
      {
        problem: 'El CPM no aparece',
        doWhat: [
          'CPM = coste ÷ vistas reales × 1.000. Sin "Fee Acordado (€)" en Elegir no hay coste; sin vistas reales no hay base.',
          'Rellena los fees acordados y consigue vistas reales (captura o cuenta conectada). Una celda vacía en la exportación significa "muestra insuficiente", no cero.',
          'Recuerda que el CPM es interno: el cliente no lo ve en ningún sitio, así que no falta nada en su informe.',
        ],
      },
      {
        problem: 'La checklist "Prometido vs entregado" sale ámbar',
        doWhat: [
          'Creadores: solo cuentan como previstos los que están en Acordado o superior y como entregados los que tienen al menos una publicación. Actualiza estados en Elegir.',
          'Piezas: compara lo publicado con "Entregables comprometidos" de cada creador; revisa que el número esté puesto y que las piezas se hayan capturado.',
          'Fechas: alguna publicación cae fuera del periodo; comprueba las fechas de la campaña.',
          'Identificación legal: faltan #publicidad / #publi / "Publi" / colaboración pagada / #ad en el texto de alguna publicación de feed; pide a la creadora que lo añada.',
          'Si el sistema se equivoca por un motivo real, en "Editar informe" pasa la fila a Manual, fija Prometido / Entregado y Estado "Cumplido" con una Nota corta. Solo entonces le llega al cliente.',
        ],
      },
      {
        problem: 'Una fila no llega al cliente',
        doWhat: [
          'En "Prometido vs entregado" el cliente solo ve las filas "Cumplido": una fila "Revisar" / "En revisión" se queda en tu pantalla. Corrige el dato o pásala a Manual con Estado "Cumplido".',
          'En Creadores o Anexo: la fila está marcada "Oculto al cliente"; pulsa "Volver a mostrar al cliente".',
          'La columna "Creadores · Coste y CPM" y las tarjetas económicas nunca llegan: no es un error.',
        ],
      },
      {
        problem: 'El PDF muestra algo que no quiero',
        doWhat: [
          '"Editar informe" → "Secciones — Ocultar al cliente" o "Columnas y tarjetas — Ocultar al cliente"; en las tablas, "Ocultar esta fila al cliente". Guarda y vuelve a "Descargar PDF".',
          'El PDF es siempre la versión cliente (sin Balance, "Datos: qué es real", coste, CPM ni Ratio EMV): lo que ves en pantalla con los bloques de agencia fuera. Si lo que sobra es texto tuyo, edítalo en Título, Subtítulo, Introducción o Conclusiones.',
          'Usa "Descargar PDF" (servidor, A4), no "Imprimir": Imprimir es el diálogo del navegador y depende de sus ajustes.',
        ],
      },
      {
        problem: 'No salen stories',
        doWhat: [
          'Las stories solo se escanean de creadoras en Acordado o superior; en Prospecto, Contacto o Negociando no. Cambia el estado en Elegir.',
          'La campaña debe estar activa, dentro de fechas y durar 62 días o menos; las campañas largas no escanean stories.',
          'El escaneo es cada 12 h y la story caduca a las 24 h: si se publicó entre ciclos, regístrala a mano en Ejecutar → Stories → "Registrar Story".',
          'Si la pestaña Stories muestra el aviso de pausa por presupuesto de Apify, el rastreo automático está parado porque Apify ha llegado al 95 % del plan mensual: se reanuda solo en la fecha del nuevo ciclo que indica el aviso (los ADMIN reciben "…pausado por presupuesto de Apify" una vez al día). Las stories de ese periodo no se recuperan: regístralas a mano con la captura de la creadora. Con el plan agotado se para también el scraping hasta el siguiente ciclo.',
          'Las menciones con sticker llegan al instante solo si la marca tiene conectado su Instagram (Marcas → "Copiar link de conexión IG") y ha concedido el permiso de mensajes en el diálogo de Meta.',
        ],
      },
      {
        problem: 'La plataforma no recoge stories ni el enlace manual',
        doWhat: [
          'Elegir: la creadora debe estar en Acordado o superior; en Prospecto, Contacto o Negociando no se rastrean stories.',
          'La campaña debe estar activa, dentro de "Fecha de Inicio" / "Fecha de Fin" y durar 62 días o menos.',
          'Mira la pestaña Stories: si avisa de una pausa por presupuesto de Apify, el rastreo automático está parado hasta la fecha del nuevo ciclo que indica; las stories de ese periodo caducaron a las 24 h y no se recuperan.',
          'Camino (a): Ejecutar → Media → "Añadir publicación por URL" con el enlace de la story (instagram.com/stories/usuario/…): la fecha se lee del propio enlace y no se consulta Apify; el formulario cambia a Vistas y Alcance (Likes y Comentarios no aplican a una story): tecléalos de la captura de la creadora o complétalos después con "Registrar estadísticas". Si la fecha no se puede leer del enlace, aparece el campo "Fecha de publicación" (obligatorio). Los destacados (highlights) no valen.',
          'Camino (b): Ejecutar → Stories → "Registrar Story": Influencer, Vistas, Alcance, Respuestas, Enlace (si pegas el enlace la fecha se lee sola), "Fecha de publicación" (opcional; obligatoria si la campaña ya terminó) → "Guardar Story". Si algo falla, el formulario muestra el motivo: creadora fuera de la campaña, fecha fuera del periodo o enlace de otra creadora.',
          'Las vistas y el alcance de una story nunca son públicos: pide la captura a la creadora antes de las 24 h y tecléalos.',
        ],
      },
      {
        problem: 'Las miniaturas salen en blanco',
        doWhat: [
          'Las URLs de imagen de Instagram y TikTok caducan a los pocos días. La plataforma guarda una copia duradera de cada miniatura al capturar; en Instagram, además, recupera sola las caducadas a partir de la página pública de la publicación, sin coste de Apify. En TikTok no hay recuperación: si la copia no se guardó al capturar, la miniatura se queda en blanco.',
          'Espera unos minutos y recarga el informe; si sigue en blanco, la publicación puede ser privada o estar borrada (aparecerá "Eliminado por el creador").',
          'No hace falta reemplazar nada a mano; si un caso concreto no se recupera, avisa a David con la URL de la publicación.',
        ],
      },
      {
        problem: 'Apify está agotado',
        doWhat: [
          'Señales: banner en Creadores ("La búsqueda en vivo está temporalmente no disponible…") y rastreos que fallan.',
          'No es lo mismo que la pausa por presupuesto: al 85 % del plan (o al límite del administrador) se pausa solo "Buscar más en Apify" (Creadores: "pausada por presupuesto hasta el dd/mm"); al 95 % se pausan también las stories y las publicaciones automáticas, con aviso a los ADMIN y en la pestaña Stories con la fecha del nuevo ciclo. Analizar un perfil y "Añadir publicación por URL" siguen funcionando hasta que el plan se agota.',
          'Mientras dura: no funcionan "Por @usuario", "Buscar más en Apify" (el botón no aparece y sale un aviso sin cifras), analizar perfiles nuevos ni la captura por scraping; sí funcionan la "Base de datos", "Por categoria" en nuestra base, Similares, todo lo que llega por Meta y lo ya guardado.',
          'Solución: esperar al reinicio del ciclo mensual (la fecha aparece en el banner) o que David amplíe el límite en Apify → Billing. Mientras, prioriza "Invitar a conectar" y las capturas de estadísticas.',
        ],
      },
      {
        problem: 'El EMV parece bajo o alto',
        doWhat: [
          'Reels y vídeos solo cuentan con vistas reales (y vistas ≥ likes); una pieza sin vistas reales aporta cero al EMV aunque tenga muchos likes. Registra sus estadísticas.',
          'Las stories sin vistas se estiman por tier (seguidores × %); con vistas reales registradas manda el dato real y el EMV cambia.',
          'Las tarifas están en Ajustes → Benchmarks → "Tasas EMV" (CPM por formato, "Valor por vista", "Multiplicador de confianza"). Solo David las cambia; no compenses a mano.',
          'Si el cliente compara con su CPM de Meta Ads: los CPM del EMV llevan una prima de creador (contenido nativo, confianza, permanencia). El Ratio EMV nunca se llama ROI.',
        ],
      },
      {
        problem: 'El cliente no ve la campaña en el portal',
        doWhat: [
          'La campaña tiene que tener "Marca / Cliente" asignada; solo se elige al crearla (Campañas → "Nueva Campaña" → "Marca / Cliente"): "Editar Campaña" no tiene ese campo. Si se creó sin marca, avisa a David.',
          'Marcas → "Usuario Marca (solo lectura)": el usuario debe estar vinculado a ESA marca y tener rol Brand (Ajustes → Equipo).',
          'Comprueba que entra en /portal con el email invitado; cualquier otra ruta le redirige al portal.',
        ],
      },
      {
        problem: 'No veo una campaña que lleva otra PM',
        doWhat: [
          'Las campañas solo aparecen en la lista de su creador y de las personas con acceso (los ADMIN las ven todas). No es un error.',
          'Pide al creador de la campaña o a un ADMIN que la abra → cabecera → "Equipo" → "Equipo de la campaña" → active "Tiene acceso" en tu fila.',
          'Recibirás el aviso "Acceso a campaña"; desde entonces la campaña aparece en Campañas, Inicio y Calendario y te llegan sus notificaciones.',
          'Marcas → "Gestionar Empleados" no sirve para esto: solo da acceso a la ficha de la marca.',
        ],
      },
      {
        problem: 'Una dirección no se rellena en el modal de envío',
        doWhat: [
          'El prefill solo actúa si el creador aún no tiene dirección escrita en esta campaña y Contactos guarda una. Mira Contactos → columna Dirección: si dice "Sin dirección", tecléala en el modal y "Guardar Datos"; quedará guardada para la próxima.',
          'Si en Contactos hay dirección pero el modal no la muestra, cierra y vuelve a abrir "Datos de Envío"; si persiste, "Editar dirección" en Contactos (la calle es obligatoria) y reintenta.',
        ],
      },
      {
        problem: 'Un reel aparece con 0 vistas',
        doWhat: [
          'Ha entrado por la etiqueta de la marca vía Meta, que no da las vistas de cuentas ajenas; el enriquecimiento automático las completa con el dato público.',
          'Si sigue en 0 (cuenta privada, reel borrado, Apify agotado), pide la captura de estadísticas y regístrala con "Registrar estadísticas".',
        ],
      },
      {
        problem: 'No puedo crear o guardar la campaña',
        doWhat: [
          'Falta el "Objetivo de la campaña" o un objetivo numérico mayor que 0 ("Rellena al menos un objetivo numérico para poder guardar."). En Social Listening son opcionales.',
          'Si los objetivos ya están congelados, indica el "Motivo del cambio" antes de guardar.',
        ],
      },
      {
        problem: 'Falta la línea base de un creador',
        doWhat: [
          'Todavía no ha pasado a Acordado (se congela en ese momento), o tenía menos de 6 publicaciones del formato negociado en los últimos 180 días.',
          'Elegir → "Introducir línea base" con las medianas que te dé la creadora (Formato, Vistas medianas, Interacciones medianas, n). Las stories no tienen línea base.',
        ],
      },
      {
        problem: 'La ficha y el informe (o el portal) muestran cifras distintas',
        doWhat: [
          'Todo sale del mismo cálculo. La única diferencia legítima: ocultaste publicaciones o creadores en el informe (los totales se recalculan sin ellos) o el cliente no ve las cifras económicas.',
          'Si no es eso, recarga; si persiste, es un error: anota campaña, pantalla y cifra y avisa a David.',
        ],
      },
    ],
  },
]

/**
 * Digesto compacto de cada sección para el bloque de sistema del asistente.
 * Misma información y mismos rótulos que MANUAL_SECTIONS, en pocas líneas
 * (el manual completo ronda los 30.000 caracteres; el prompt admite 12.000).
 * Clave = id de la sección. Si añades una sección, añade su digesto aquí.
 */
const MANUAL_DIGEST: Record<string, string> = {
  acceso:
    'Login en intelligence.thekingofcontent.agency; invitaciones en Ajustes → Equipo. Roles: ADMIN (todo), EMPLOYEE (PM), BRAND (cliente, solo lectura en /portal), CREATOR. "TKOC AI" no ejecuta acciones. Acceso del cliente: Marcas → "Usuario Marca (solo lectura)". Campañas: cada PM ve las que creó o con acceso; ADMIN ve todas. Dar acceso: ficha → "Equipo" → "Tiene acceso" (solo creador o ADMIN); la PM recibe "Acceso a campaña". Campana: solo avisos de tus campañas; alertas de sistema (crons, presupuesto de Apify) solo ADMIN.',
  'crear-campana':
    'Campañas → "Nueva Campaña". "Marca / Cliente" (sin marca el cliente no ve la campaña). Tipo: "Seguimiento de Influencers", "Social Listening" o "Campaña UGC". "Objetivo de la campaña" (obligatorio salvo Social Listening) y "Objetivos numéricos" (al menos uno > 0: Vistas, Alcance, Interacciones, ER objetivo, CPM máximo). "Cuentas de Marca Objetivo" (@menciones y #hashtags; sin ellos no se captura nada). "Fecha de Inicio" / "Fecha de Fin" o "Siempre Activo": solo se captura lo publicado dentro. Brief. "Crear Campaña". Objetivos congelados al arrancar; cambiarlos (Aprender → "Editar Campaña") pide "Motivo del cambio".',
  'creadores-trato':
    'Ficha → Elegir: "Buscar por username...", "Añadir Creador UGC", "Añadir varios" ("Pegar lista" u "O sube un CSV", hasta 200). Estados: Prospecto → Contacto → Negociando → Acordado → Contratado → Envío → Publicado → Completado. Acordado activa el rastreo de stories, congela la línea base y cuenta en "Prometido vs entregado". "Fee solicitado (€)", "Fee Acordado (€)" (= coste), "Formato" negociado. "Entregables comprometidos", "Enlace con UTM", "Clics" ("Entregados N / M"). "Invitar a conectar", "Quitar de campaña". Pagar → "Análisis de Pricing por Influencer". Si "Sin línea base": "Introducir línea base".',
  envios:
    'Estado Envío → Ejecutar → Envíos → "Añadir envío" / "Editar envío" → modal "Datos de Envío" → "Guardar Datos". Si Contactos ya tiene dirección se rellena solo; al guardar se copia a Contactos. "Descargar CSV Envíos". Corregir: Contactos → "Editar dirección".',
  capturar:
    'Automático: posts cada 6 h (Apify), Meta cada 2 h, borrados cada 24 h, captura inmediata al añadir o pasar a Acordado+. Reglas: miembro + dentro de fechas + menciona Cuenta de Marca Objetivo o hashtag. "Rastrear Ahora" (campaña activa; siempre ejecuta, sin ventana de 3 h). Stories: cada 12 h, una ejecución, creadoras en Acordado+ de campañas activas en fechas y ≤ 62 días; caducan a las 24 h. Presupuesto de Apify: rastreo automático hasta el 95 % del plan mensual; "Buscar más en Apify" se pausa al 85 % (o límite del administrador); cada pausa avisa a los ADMIN ("…pausado por presupuesto de Apify", una vez al día) con la fecha del nuevo ciclo, también en la pestaña Stories y en Creadores ("pausada por presupuesto hasta el dd/mm"); nunca importes. Ejecutar → Media → "Añadir publicación por URL" → "Detectar desde la URL" → "Añadir publicación" (también enlaces de story: fecha del enlace, sin Apify; campos Vistas y Alcance; si no lee la fecha pide "Fecha de publicación"; highlights no). Ejecutar → Stories → "Registrar Story": Vistas, Alcance, Respuestas, Enlace (lee la fecha), "Fecha de publicación" (obligatoria si la campaña terminó) → "Guardar Story"; si falla, dice el motivo; vistas de story siempre a mano. "Registrar estadísticas": captura de la creadora → "Leer con IA" → revisar → guardar ("Estadísticas del creador"), o a mano. "Etiquetas" opcionales. "Revalidar contenido" desvincula lo que no cumple.',
  'datos-reales':
    'Guía §5: interacciones = likes + comentarios + compartidos + guardados; vistas ≥ likes o "sin dato real"; ER = interacciones ÷ vistas reales × 100 (≥ 3 publicaciones con vistas, ≥ 500 vistas, ratio ≤ 100 %, si no "Muestra real insuficiente"); audiencia real = alcance → impresiones → vistas; coste = fee acordado; CPM real = coste ÷ vistas × 1.000 (interno); una sola cifra "EMV" con "?", nunca "estimado". Solo agencia: fees, coste, CPM, EMV Básico, Ratio EMV (nunca ROI), estimada, impresiones, Balance, CPA/ROAS. Alcance, guardados, compartidos y vistas de stories solo llegan del creador ("Registrar estadísticas", "Invitar a conectar" o manual).',
  'objetivos-negocio':
    'Planificar → bloque "Resumen" → "Objetivos de campaña": KPI · Objetivo · Resultado · Variación; ±10 %: "En objetivo", "Por encima / Por debajo del objetivo", "Sin datos"; el cliente no ve la fila de CPM máximo. Planificar → "Resultados de negocio (aportados por el cliente)": Código promocional, Canjes, Ventas, Leads, Ingresos, Fuente, Fecha, Notas, "ROI (dato del cliente)"; vacío = no aparece. CPA/ROAS solo agencia. Clics: Elegir → "Enlace con UTM" → "Clics".',
  informe:
    'Ficha → "Informe (PDF)". "Editar informe": Título, Subtítulo, Introducción, Conclusiones; "Secciones — Ocultar al cliente"; "Columnas y tarjetas — Ocultar al cliente"; en Creadores/Anexo "Ocultar esta fila al cliente". "Prometido vs entregado" (filas Creadores, Piezas, Fechas, "Identificación legal"): Modo "Automático" / "Manual" (Prometido, Entregado, Estado "Cumplido" / "En revisión", Nota corta); "Compromisos adicionales" → "Añadir compromiso" (máx. 4). Al cliente solo llegan las filas "Cumplido". "Comentarios destacados" → "Añadir comentario" (máx. 12). "Marcar como enviado" → "Confirmar envío". "Descargar PDF" = versión cliente sin Balance, "Datos: qué es real", coste, CPM ni Ratio EMV.',
  portal:
    'Acceso: campaña con "Marca / Cliente" + Marcas → "Usuario Marca (solo lectura)". Ve: campañas con estado, contenido (borrados marcados), creadores con estado en su lenguaje, vistas, interacciones, audiencia real, ER sobre vistas, entregables comprometidos, "EMV" con "?", objetivos sin CPM, sus resultados de negocio, aprendizajes versión cliente, "Ver informe completo" con "Descargar PDF". No ve nada de la lista "Solo agencia", ni nota de campaña, peor creador o presupuesto. No edita ni rastrea.',
  aprender:
    'Aprender → "Inteligencia de Campaña"; "Playbook — Qué hacer a continuación" ("Repetir" / "No repetir la próxima vez", "Rendimiento por formato", "Consejo de presupuesto"); "Sin vistas reales" (≥ likes, mín. 500): no se juzgan, pide estadísticas. Informe → "Aprendizajes y próximos pasos": "Qué repetir" ("Todavía no destaca ningún creador" sin dato real), "Mejor rendimiento", "Formato ganador", "Siguiente oleada"; bloque "Solo agencia" no se imprime.',
  'contactos-listas':
    'Contactos se llena solo al añadir creadores ("Editar dirección"). Listas → "Crear nueva Lista"; dentro solo "Eliminar de la lista" y fijar (sin "Añadir a Campaña"; "Exportar" no hace nada). Creadores → "Base de datos": solo creadores con datos reales, sin Apify. "Buscar en vivo": "Por @usuario" (Apify, ~10 s) o "Por categoria" (primero gratis en nuestra base; "Buscar más en Apify" → confirmación sin cifras → "Sí, buscar en Apify" / "Cancelar" → una ejecución, guardada 7 días; al 85 % del plan de Apify se pausa: sin botón, "pausada por presupuesto hasta el dd/mm"). Por resultado "Ver perfil" y "Añadir a..." (solo a una lista). Similares y "Buscar Similares": mismo motor, solo nuestra base; afinidad temática primero, luego "Audiencia comparable"; fuente sin categoría → todos "Audiencia comparable" (analízalo antes); Apify solo para un fuente fuera de la base o "Añadir a lista" sin ficha.',
  ajustes:
    'Pestañas Perfil, Equipo, Integraciones, Benchmarks (solo ADMIN), Facturación. Equipo → "Invitar Miembro" → "Enviar Invitación" (asignar marcas no da acceso a campañas). Integraciones: Apify ("Probar Conexión"), Meta ("Connect with Facebook", "Reconnect", "Sincronizar"). Benchmarks → "Tasas EMV": "Tasas CPM (por 1.000 de audiencia)", "Stories: audiencia estimada (% de seguidores)", "Publicaciones: alcance estimado (% de seguidores)", "Valor por vista (reels y vídeos)" (0 = CPM), "Multiplicador de confianza" (×1 = apagado). Fees, CPM aceptable, mercados y modificadores: cerrados, solo David.',
  'que-hacer-si':
    'Primero reglas de captura (miembro, fechas, mención), campaña activa y estado de Apify/Meta.',
}

/**
 * Solución en una línea por problema (clave = texto del problema) para el
 * prompt; la página muestra la lista completa de acciones.
 */
const MANUAL_FIX_DIGEST: Record<string, string> = {
  'Una creadora no muestra publicaciones':
    'cuentas objetivo en la campaña → miembro en Elegir → publicación en fechas y con mención/hashtag (si no, "Añadir publicación por URL") → Apify ni pausado ni agotado → "Rastrear Ahora" o "Sincronizar" en Integraciones.',
  'La tasa de engagement dice "Muestra real insuficiente"':
    'faltan ≥ 3 publicaciones con vistas reales, 500 vistas y ratio plausible; pide capturas: "Registrar estadísticas", "Invitar a conectar" o "Registrar Story". Nunca estimaciones.',
  'El CPM no aparece':
    'sin "Fee Acordado (€)" no hay coste; sin vistas reales no hay base. Interno: el cliente no lo ve.',
  'La checklist "Prometido vs entregado" sale ámbar':
    'estados Acordado+, "Entregables comprometidos" rellenos, fechas en el periodo, #publicidad en el texto; si el sistema se equivoca, "Editar informe" → fila en Manual, Estado "Cumplido", Nota corta.',
  'Una fila no llega al cliente':
    'solo salen las filas "Cumplido" (corrige o pásala a Manual → "Cumplido"); en Creadores/Anexo "Volver a mostrar al cliente"; coste y CPM nunca salen.',
  'El PDF muestra algo que no quiero':
    '"Editar informe" → ocultar sección, columna o fila → guardar → "Descargar PDF" (siempre versión cliente; no "Imprimir").',
  'No salen stories':
    'creadora en Acordado+, campaña activa, en fechas y ≤ 62 días; escaneo cada 12 h, caduca a 24 h; pausa por presupuesto → aviso en Stories con la fecha de vuelta; lo perdido, a mano ("Registrar Story").',
  'La plataforma no recoge stories ni el enlace manual':
    'reglas de stories (Acordado+, activa, en fechas, ≤ 62 días) y pausa por presupuesto en Stories (esas no se recuperan); a mano: "Añadir publicación por URL" con el enlace de la story (fecha del enlace, sin Apify) o "Registrar Story" con "Fecha de publicación" → "Guardar Story" (si falla, dice el motivo); vistas con "Registrar estadísticas".',
  'Las miniaturas salen en blanco':
    'las URLs caducan; hay copia duradera y en Instagram (no TikTok) se recuperan solas; si persiste, avisa a David con la URL.',
  'Apify está agotado':
    'banner en Creadores (no es la pausa por presupuesto del 85 % / 95 %); sin "Por @usuario", "Buscar más en Apify" ni scraping hasta el nuevo ciclo; siguen "Base de datos", "Por categoria", Similares y Meta.',
  'El EMV parece bajo o alto':
    'reels/vídeos solo cuentan con vistas reales (≥ likes): registra estadísticas; stories sin vistas se estiman por tier; tarifas en Ajustes → "Tasas EMV" (solo David). Ratio EMV nunca es ROI.',
  'El cliente no ve la campaña en el portal':
    'campaña con "Marca / Cliente" (solo al crearla, no en "Editar Campaña"); Marcas → "Usuario Marca (solo lectura)" vinculado a esa marca con rol Brand.',
  'No veo una campaña que lleva otra PM':
    'solo la ven su creador y quien tiene acceso (ADMIN, todas); pide al creador o a un ADMIN: ficha → "Equipo" → "Tiene acceso". Marcas → "Gestionar Empleados" no da acceso.',
  'Una dirección no se rellena en el modal de envío':
    'solo si Contactos guarda dirección y esta campaña aún no tiene; si "Sin dirección", tecléala y "Guardar Datos"; si la hay, reabre "Datos de Envío" o "Editar dirección".',
  'Un reel aparece con 0 vistas':
    'entró por Meta (sin vistas de cuentas ajenas); el enriquecimiento las completa; si sigue en 0, "Registrar estadísticas".',
  'No puedo crear o guardar la campaña':
    'falta el "Objetivo de la campaña" o un objetivo numérico > 0; con objetivos congelados, indica el "Motivo del cambio".',
  'Falta la línea base de un creador':
    'aún no está en Acordado o tenía < 6 publicaciones del formato en 180 días; Elegir → "Introducir línea base".',
  'La ficha y el informe (o el portal) muestran cifras distintas':
    'legítimo solo si ocultaste filas en el informe o el cliente no ve cifras económicas; si no, recarga y avisa a David.',
}

/** Compacta un texto para el prompt: quita saltos y espacios dobles. */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Versión de texto plano del manual para el bloque de sistema del asistente
 * (≤ 12.000 caracteres): el digesto de cada sección y, en "Qué hacer si…",
 * cada problema con su solución en una línea. La página /manual muestra los
 * pasos completos, los consejos y todas las soluciones.
 */
function renderManualText(sections: ManualSection[]): string {
  const blocks = sections.map((s, i) => {
    const lines: string[] = [`## ${i + 1}. ${s.title}`]
    const digest = MANUAL_DIGEST[s.id]
    if (digest) lines.push(squash(digest))
    for (const t of s.troubleshooting || []) {
      const fix = MANUAL_FIX_DIGEST[t.problem] ?? t.doWhat[0]
      lines.push(`- ${t.problem}: ${squash(fix)}`)
    }
    return lines.join('\n')
  })
  return `# Manual de la PM (rótulos reales de la interfaz; completo en /manual)\n${blocks.join('\n')}`
}

export const MANUAL_TEXT: string = renderManualText(MANUAL_SECTIONS)
