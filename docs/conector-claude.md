# Conector de Claude para TKOC Intelligence

Guía para el dueño de la plataforma. Actualizada el 12 de noviembre de 2026, cuando el conector pasó de solo leer a poder hacer cambios.

## Qué es

Es un conector MCP. Une Claude con TKOC Intelligence.

Con él puedes pedirle a Claude que consulte la plataforma y también que haga cosas en ella. Lo mismo que hace un PM o un administrador con campañas, creadoras, publicaciones, stories, estados, fees, envíos, listas, notas, informes, marcas y rastreos.

Claude actúa con el usuario del administrador que lo conectó. Pasa por la propia plataforma, así que se aplican las mismas reglas, comprobaciones y avisos que cuando lo haces tú en pantalla.

Lo delicado siempre te lo pide confirmar antes. Lo explica la sección «Qué te pide confirmar y cómo».

Funciona en tres sitios:

- La app de escritorio de Claude.
- claude.ai, en el navegador.
- Claude Code, en la terminal.

La dirección del conector es esta:

```
https://intelligence.thekingofcontent.agency/api/mcp
```

También está en Ajustes, pestaña Integraciones, en la tarjeta «Conexiones con Claude», lista para copiar.

## Quién puede conectarlo

- Solo un administrador con la cuenta activa.
- Un empleado (rol EMPLOYEE) ve este aviso: «Solo un administrador puede conectar Claude con la plataforma.»
- Una cuenta de marca o de creadora no llega a la pantalla de permiso.
- Cada conexión queda a nombre del administrador que la aprobó. Todo lo que haga Claude por esa conexión, lo hace con su usuario.
- La plataforma comprueba en cada llamada que esa persona sigue siendo administradora y sigue activa.
- Si deja de serlo, sus conexiones se cortan en el momento. No vuelven solas aunque recupere el rol. Tiene que conectar de nuevo.

## Cómo conectarlo

### En la app de escritorio de Claude o en claude.ai (plan Free, Pro o Max)

Los pasos son los mismos en los dos sitios. Comprobados con la guía oficial de Claude el 12 de noviembre de 2026.

1. Abre «Customize» y entra en «Connectors».
2. Pulsa «+» («Add») y elige «Add custom connector».
3. En el nombre escribe `TKOC Intelligence`.
4. En la URL pega `https://intelligence.thekingofcontent.agency/api/mcp`. Tal cual, sin barra al final.
5. Pulsa «Continue».
6. Si Claude pregunta por los ajustes de acceso:
   - En «Authentication», elige «Sign in now».
   - En «OAuth client», elige «Register automatically». NO elijas «Use Claude's published identity», aunque salga marcada como recomendada: este servidor no la admite y la conexión fallaría. Si Claude ya marca «Register automatically» como «Detected», déjala.
   - No escribas nada en «Request headers».
7. Pulsa «Add».
8. Pulsa «Connect». Claude abre la plataforma en el navegador.
9. Si no tienes la sesión abierta, entra con tu cuenta de administrador.
10. Aparece la pantalla de permiso. Léela: dice quién pide acceso y qué podrá hacer (lo verás en el apartado siguiente).
11. Pulsa «Permitir». Con «Cancelar» no se conecta nada.
12. Vuelves a Claude con el conector listo.

En cada chat, el conector se enciende o se apaga en el botón «+» del chat, en «Connectors».

Si tu Claude está en español, los nombres del menú pueden aparecer traducidos.

### En un plan Team o Enterprise de Claude

Ahí no lo añade cada persona: lo añade un Owner de la organización de Claude, una vez.

1. El Owner abre «Organization settings» y entra en «Connectors».
2. Pulsa «Add», después «Custom» y, si pregunta el tipo, «Web».
3. Escribe el nombre y la URL como arriba y sigue los pasos 5 a 7 (en «OAuth client», «Register automatically»).
4. Después, cada administrador de TKOC Intelligence que quiera usarlo abre «Customize», «Connectors», busca el conector con la etiqueta «Custom» y pulsa «Connect». Inicia sesión en la plataforma y pulsa «Permitir».

Cada administrador queda con su propia conexión. Un empleado de la plataforma no puede conectarlo aunque lo vea en Claude.

### En Claude Code

1. En la terminal, ejecuta:

   ```
   claude mcp add --transport http tkoc https://intelligence.thekingofcontent.agency/api/mcp
   ```

2. Abre Claude Code y escribe `/mcp`.
3. Elige `tkoc` e inicia sesión. Se abre la plataforma en el navegador.
4. Entra con tu cuenta de administrador si hace falta.
5. Lee la pantalla de permiso y pulsa «Permitir».

### La pantalla de permiso

Dice tres cosas, siempre las mismas:

- Qué puede hacer: «Leer y modificar campañas, creadoras, publicaciones, listas, informes y rastreos, con tu usuario.»
- Qué te pedirá confirmar siempre: «Borrar, gastar Apify, enviar correos, cambios en bloque y los textos del informe que ve el cliente.»
- Qué no puede tocar nunca: «Usuarios, permisos, claves e integraciones.»

### Después de conectar

- Cada vez que pulsas «Permitir» se crea una conexión.
- Cada conexión aparece en su propia fila en Ajustes, pestaña Integraciones.
- El permiso se renueva solo mientras se usa.
- Una conexión que pasa 60 días sin uso caduca. Entonces hay que conectar de nuevo.

### Si la conectaste antes de que existieran las acciones

Esa conexión sigue funcionando, pero solo lee. Cuando le pidas un cambio, Claude te dirá que la conexión es de solo lectura.

1. Quita el conector en Claude.
2. Vuelve a añadirlo con los pasos de arriba.
3. En Ajustes, revoca la conexión antigua si sigue en la lista: es la que lleva la etiqueta «Solo lectura». La nueva no la lleva.

## Qué puede hacer Claude

No hace falta saber el nombre de ninguna herramienta. Pídeselo con tus palabras y Claude elige.

- Campañas: crearlas, editar sus datos y fechas, decidir qué se rastrea (cuentas de la marca, hashtags y palabras clave del producto), fijar el objetivo y las metas, anotar los resultados de negocio que dio el cliente, activarlas, pausarlas o archivarlas, y dar o quitar acceso a alguien del equipo.
- Creadoras de una campaña: añadirlas, moverlas de estado, poner fee, condiciones y entregables, guardar sus datos de envío, dejar notas internas, copiarlas o moverlas a otra campaña y quitarlas.
- Publicaciones y stories: añadir publicaciones por su enlace, registrar stories a mano con sus cifras, corregir las métricas de una pieza con la captura de la creadora y etiquetar piezas (ángulo, gancho y beneficio).
- Informe: ocultar o mostrar piezas, creadoras, secciones y columnas, editar sus textos y anotar que se ha enviado. Anotarlo no envía nada al cliente.
- Rastreo: lanzar «Rastrear ahora», sincronizar una cuenta de Instagram de marca y revalidar los contenidos de una campaña.
- Creadoras en la base: analizar un perfil, importar una lista de usuarios, ampliar una búsqueda con Apify, crear una ficha a mano y editar la ficha (fee estándar, contacto, web y género).
- Listas: crearlas, añadir y quitar creadoras, renombrarlas, fijarlas, archivarlas y borrarlas.
- Contactos: guardar o corregir la dirección de envío de una creadora.
- Marcas: crearlas, cambiar su nombre o su web y borrarlas.
- Invitar a una creadora, por correo, a conectar su cuenta de Instagram.
- Sigue pudiendo consultarlo todo, como antes: campañas, resultados, creadoras, publicaciones y el estado de la captura.

Para lo que no tiene una herramienta propia hay una genérica de último recurso (`platform_request`). Solo llega a una lista cerrada de pantallas de la plataforma y aplica las mismas confirmaciones. Lo demás lo rechaza.

### Ejemplos

- «Añade estas tres creadoras a la campaña de noviembre: @ana.fit, @luis.cocina y @marta.viaja.»
  Gasta Apify: busca a las que no están en la base y lee su contenido. Te enseña antes en el chat a quién va a añadir y qué va a leer, y espera tu sí.
- «Pon a Marta en Contratado con 300 €.»
  El fee se pone directamente. Pasar a Contratado lanza una lectura de su perfil en Apify para capturar su contenido, así que eso te lo pregunta antes en el chat.
- «Oculta esta publicación del informe.»
  Se hace directamente y te dice qué ha cambiado. Si son más de 5 piezas o creadoras a la vez, te pide el sí antes.
- «Lanza el rastreo de Dorco.»
  Es lo que más Apify gasta. Te enseña cuántas creadoras, hashtags y cuentas va a leer y el porcentaje del plan usado, y espera tu sí.
- «Apunta que @luis.cocina pidió 400 €.»
  Deja una nota interna firmada con tu nombre. Se hace directamente.
- «Borra la lista "Verano".»
  Borrar no se confirma en el chat: Claude te da un enlace a la plataforma y lo confirmas tú allí.

## Qué te pide confirmar y cómo

Hay dos maneras. Las decide la plataforma, no Claude: aunque Claude se equivoque o lo intente, no puede saltárselas.

### 1. En el chat: gastar Apify, cambios en bloque y textos del informe

Para todo lo que gasta Apify, para los cambios en bloque (más de 5 elementos en una misma petición: campañas, creadoras, piezas o stories) y para cambiar los textos del informe que ve el cliente (título, subtítulo, introducción, conclusiones, comentarios destacados y «Prometido vs entregado»). En estos te enseña el texto de antes y el de después.

1. Claude pide la acción. La primera vez no se hace nada.
2. Te enseña una vista previa en español: qué va a hacer, con qué y con cuántos. Si gasta Apify, qué lecturas hace y el porcentaje del plan usado. Nunca un importe en euros ni en dólares.
3. Tú contestas que sí en el chat.
4. Claude repite la petición con un código de confirmación y entonces se hace.

El código vale 5 minutos y sirve una sola vez. Si cambia cualquier dato (otra creadora, otro importe) o la situación cambió entre medias, no se hace nada y Claude te enseña una vista previa nueva.

Antes de ofrecer cualquier gasto de Apify, la plataforma mira cómo está Apify. Si no está disponible o el presupuesto está bloqueado, no ofrece la acción y dice por qué. El gasto opcional (búsquedas, análisis e importaciones de creadoras) se pausa al 85 % del plan. La captura de las campañas, al 95 %.

### 2. En la plataforma, con tu contraseña: borrar, enviar correos y lo que ve gente de fuera

Para borrar cualquier cosa, para lo que no se puede deshacer (quitar una creadora de una campaña, revalidar contenidos, mover creadoras), para escribir a una persona y para cambiar un widget de captación que ya funciona en la web de un cliente.

1. Claude pide la acción. La primera vez no se hace nada.
2. Te da un enlace como este: `https://intelligence.thekingofcontent.agency/mcp/confirmar/...`
3. Ábrelo. Si hace falta, entra con tu cuenta de administrador.
4. La página dice qué va a hacer, si borra algo que no se puede deshacer o si sale fuera de la agencia, quién lo pide y cuándo caduca.
5. Para confirmar, escribe tu contraseña de la plataforma y pulsa «Confirmar». Para cancelar basta con «Cancelar».
6. Vuelve a Claude y dile que continúe. Lo hace una sola vez y con los datos que se guardaron al pedirlo, no con lo que mande después.

Reglas:

- Caduca a los 15 minutos desde que Claude lo pidió. Si caduca, no se hace nada. Se puede volver a pedir.
- Solo puede confirmarlo el administrador que conectó ese Claude. Otro administrador ve de quién es, pero no puede confirmarlo ni cancelarlo. Un empleado no puede confirmar nada.
- Si revocas la conexión, lo que tenía pendiente ya no se hace.
- Lo pendiente también aparece en Ajustes, en la actividad de Claude, con su botón «Confirmar».
- Si entre tu «Confirmar» y la llamada de Claude cambia algo de lo que dependía la acción (otras fechas o reglas de la campaña, otra situación), no se hace nada: Claude tiene que pedirla de nuevo y tú ves la vista previa nueva.
- Cinco contraseñas incorrectas seguidas pausan «Confirmar» unos minutos.

Se confirma fuera de Claude a propósito. Claude lee textos que escriben otras personas: pies de foto, biografías, nombres. Si alguien escribe ahí una orden, Claude podría leerla, pero no puede confirmar nada en tu nombre.

Por eso se pide la contraseña. Claude puede manejar tu Chrome, con tu sesión abierta (la extensión Claude in Chrome), y pulsar un botón. Tu contraseña no la conoce y sus reglas le prohíben escribir contraseñas. Escríbela siempre tú, y no dejes que Claude abra ese enlace por ti.

En el chat, la confirmación queda atada a lo que viste: si después cambia algo (por ejemplo, la campaña pasa a tener hashtags y lo que era gratis ahora gasta Apify), tu sí no vale y Claude te enseña otra vista previa.

### Lo que se hace sin preguntar

Los cambios pequeños y que se pueden corregir: editar los datos de una campaña, sus objetivos, el fee de hasta 5 creadoras, notas, crear listas o marcas. Claude te dice después qué ha cambiado, con el valor de antes y el de después.

Los textos del informe ya no entran aquí: lo que Claude escribe ahí lo ve el cliente al momento, en el portal y en el PDF, así que siempre te pide el sí en el chat antes (decidido el 12 de noviembre de 2026).

Si pides algo en bloque, Claude lo manda de una vez y te pide el sí. No debe partirlo en trozos de 5 para que no te lo pregunte.

## Qué no puede hacer nunca

- Usuarios, roles y permisos. Tampoco invitar a gente del equipo.
- Claves e integraciones: Apify, Meta y YouTube. Ni conectar ni desconectar cuentas.
- Sus propias conexiones: no puede verlas, ampliarlas, revocarlas ni confirmar sus propias acciones.
- Inicio de sesión y contraseñas.
- Las tareas programadas de la captura y los datos de prueba.
- Borrar datos personales a petición de alguien (RGPD). Eso se hace a mano.
- Gastar crédito de IA de la plataforma, rastrear comentarios, crear permisos de uso de anuncios o avisar por correo al equipo.
- Escribir a una persona sin tu confirmación. Solo hay una acción que envía un correo: invitar a una creadora a conectar su Instagram. Una persona por vez y como mucho 5 al día.
- Cambiar sin tu confirmación un widget de captación que ya está en la web de un cliente (textos, logo, color, dominios o apagarlo).
- Lanzar «Rastrear ahora» si su revalidación final fuera a sacar piezas de la campaña, ni en una campaña sin cuentas, hashtags ni palabras clave. Antes hay que revalidar (eso lo confirmas tú en la plataforma) o corregir las reglas.
- Leer Instagram, TikTok o YouTube por su cuenta. Lo lee la plataforma, con Apify, y solo con tu sí.

## Datos de contacto y cifras internas

- Correos, teléfonos y direcciones solo llegan si los pides de forma expresa. Por ejemplo: «dame la dirección de envío de Marta». Si no, la respuesta dice solo si el dato existe.
- Fees, costes, CPM y EMV, igual: solo si los pides. Llegan marcados como dato interno. Si vas a enseñar la conversación a un cliente, no los pidas.
- Nunca llegan contraseñas, tokens, claves ni enlaces de invitación.
- Los importes de Apify no se envían nunca. Solo el porcentaje del plan usado.

## Límites

Por cada conexión:

- 120 llamadas a herramientas cada 10 minutos.
- 20 cambios por minuto y 300 al día.
- 60 consultas por minuto con la herramienta genérica (`platform_request`). No cuentan como cambios.
- 30 acciones que gastan Apify al día.
- 5 correos a personas al día, y 5 cambios de widgets al día.
- Una respuesta ocupa como mucho 60.000 caracteres. Si se corta, lo dice.

Al pasar un límite, Claude recibe un aviso y no se hace nada. La conexión no se corta.

## Cómo ver lo que ha hecho

1. Entra en la plataforma con tu cuenta de administrador.
2. Ve a Ajustes y abre la pestaña Integraciones.
3. Baja hasta la tarjeta «Conexiones con Claude» y, debajo, «Actividad de Claude».

Ahí ves:

- Arriba, «Esperando confirmación»: lo que espera un «Confirmar». Lo tuyo aparece primero, con la vista previa y el botón «Confirmar». Lo de otros administradores dice de quién es.
- Debajo, «Últimas acciones»: las 50 llamadas más recientes de todas las conexiones. De cada una: la herramienta, el resultado, cuándo y quién.
- El botón «Actualizar» trae lo último.

Los resultados:

| Resultado | Qué quiere decir |
|---|---|
| Consulta | Ha leído datos. No ha cambiado nada. |
| Hecho | Ha hecho el cambio. |
| Pidió tu sí en el chat | Te enseñó una vista previa. Aún no ha hecho nada. |
| Pidió que confirmes aquí | Creó una acción para confirmar en la plataforma. Aún no ha hecho nada. |
| No se hizo | Se paró antes: faltaba tu confirmación, la conexión era de solo lectura, Apify estaba bloqueado o se llegó a un límite del día. |
| Falló | La plataforma o la herramienta dio un error. |
| Límite alcanzado | Demasiadas llamadas seguidas. |
| Datos no válidos | Claude mandó datos que no valen, o una herramienta que no existe. |
| En curso | Se está haciendo ahora. |
| Sin terminar | Empezó y no llegó a terminar (por ejemplo, si el servidor se reinició). Comprueba en la plataforma si se llegó a hacer. |

Algunas filas llevan además una etiqueta: «Gasta Apify», «En bloque», «Lo ve el cliente», «No se puede deshacer» o «Sale fuera» (un correo a una persona o un cambio que ve gente de fuera de la agencia).

Las consultas que Claude hace con la herramienta genérica salen como «Consulta», no como «Hecho».

Qué se guarda de cada llamada: la herramienta, un resumen corto de lo pedido (identificadores y usuarios, nunca textos), quién, cuándo, cuánto tardó y si fue bien. Las respuestas no se guardan.

Además, lo que hace Claude queda en la plataforma como si lo hubieras hecho tú: las notas van firmadas con tu nombre y el equipo recibe los avisos de siempre. Si los objetivos de una campaña ya estaban congelados, sus cambios quedan en el historial de objetivos.

### Qué es cada herramienta

Los nombres que salen en la actividad. Entre paréntesis, lo que pide confirmar.

Campañas:

- `create_campaign`: crear una campaña. Nace activa.
- `update_campaign`: editar nombre, fechas, redes, país, tipo de pago o brief.
- `set_campaign_status`: activar, pausar o archivar (en bloque si son más de 5).
- `set_campaign_tracking_targets`: cuentas de la marca, hashtags y palabras clave del producto.
- `set_campaign_goals`: objetivo y metas numéricas.
- `record_business_results`: resultados de negocio que dio el cliente.
- `delete_campaign`: borrar una campaña (en la plataforma).
- `revalidate_campaign_media`: revalidar los contenidos con las reglas actuales (en la plataforma).
- `set_campaign_access`: dar acceso a alguien del equipo; quitarlo se confirma en la plataforma.

Creadoras de una campaña:

- `add_creators_to_campaign`: añadir creadoras (gasta Apify).
- `set_creator_status`: cambiar de estado (gasta Apify al pasar a Acordado o a un estado posterior).
- `update_creator_deal`: fee, condiciones y entregables (en bloque si son más de 5).
- `set_creator_shipping`: datos de envío. Si Claude solo manda la calle, el resto de líneas (destinatario, piso, país, teléfono, correo) se quedan como estaban y la respuesta dice cuáles.
- `add_creator_note`: nota interna.
- `move_creators_between_campaigns`: copiar o mover a otra campaña (en la plataforma).
- `remove_creator_from_campaign`: quitarla de la campaña (en la plataforma).

Publicaciones e informe:

- `add_publications_by_url`: añadir piezas por enlace (gasta Apify, salvo las stories).
- `register_stories`: registrar stories a mano (en bloque si son más de 5).
- `correct_publication_metrics`: corregir las cifras de una pieza.
- `tag_publications`: etiquetar piezas (en bloque si son más de 5).
- `set_report_visibility`: ocultar o mostrar en el informe (en bloque si son más de 5).
- `edit_report_content`: textos del informe (te pide el sí en el chat: lo ve el cliente).
- `mark_report_sent`: anotar que se envió el informe.

Rastreo y creadoras en la base:

- `launch_campaign_tracking`: «Rastrear ahora» (gasta Apify). No se lanza si su revalidación final sacaría piezas.
- `sync_instagram_connection`: sincronizar una cuenta de Instagram de marca (gasta Apify).
- `analyze_creator_profile`: analizar un perfil (gasta Apify si no hay datos o tienen más de 24 horas).
- `import_creators_to_database`: importar usuarios (gasta Apify con los desconocidos).
- `run_paid_creator_search`: búsqueda de pago (gasta Apify).
- `update_creator_profile`: editar la ficha de una creadora.
- `create_creator_manually`: crear una ficha a mano, sin rastrear.

Listas, contactos y marcas:

- `create_list`, `update_list`: crear, renombrar, fijar o archivar una lista.
- `add_creators_to_list`: añadir creadoras (en bloque si son más de 5).
- `remove_creators_from_list`: quitar creadoras (en la plataforma).
- `delete_list`: borrar una lista (en la plataforma).
- `save_contact_address`: guardar la dirección de una creadora en Contactos.
- `create_brand`, `update_brand`: crear una marca, cambiar su nombre o su web.
- `delete_brand`: borrar una marca (en la plataforma).
- `invite_creator_to_connect`: invitar por correo a una creadora (en la plataforma).

Otras:

- `platform_request`: la herramienta genérica de último recurso. Borrar algo o cambiar un widget de captación se confirma en la plataforma.
- `list_campaigns`, `get_campaign`, `list_campaign_creators`, `list_campaign_media`, `find_creator`, `get_creator`, `capture_status` y `explain_missing_post`: las consultas. No cambian nada.

## Cómo revocar una conexión

1. Entra en la plataforma con tu cuenta de administrador.
2. Ve a Ajustes y abre la pestaña Integraciones.
3. Baja hasta la tarjeta «Conexiones con Claude». Está al final. Solo la ven los administradores.
4. Ahí están todas las conexiones activas, de todos los administradores. De cada una ves la aplicación, quién la autorizó, cuándo se creó y cuándo se usó por última vez. Las que se conectaron antes de las acciones llevan la etiqueta «Solo lectura».
5. Pulsa «Revocar» en la que quieras cortar y confirma con «Sí, revocar».

El corte es inmediato. Lo que esa conexión tuviera pendiente de confirmar ya no se hace. Para volver a usar Claude hay que conectar de nuevo.

Cualquier administrador puede revocar cualquier conexión.

Si quitas el conector desde Claude, mira después la tarjeta. Si la conexión sigue ahí, revócala.

## Comprobación después de publicar

La dirección que anuncia el conector tiene que ser, letra por letra, la que se escribe en Claude. Si no, Claude no conecta.

1. Abre `https://intelligence.thekingofcontent.agency/.well-known/oauth-protected-resource` en el navegador.
2. El campo `resource` tiene que ser `https://intelligence.thekingofcontent.agency/api/mcp`.

Esa dirección no sale de `NEXT_PUBLIC_APP_URL`. Sale de `NEXT_PUBLIC_MCP_BASE_URL` y, si no existe, de la dirección de producción. En producción esa variable no se pone. Solo hace falta en otro entorno, como uno de pruebas.

## Si algo no va

- Sale «Solo un administrador puede conectar Claude con la plataforma.» Has entrado con una cuenta que no es de administrador. Entra con la tuya y repite.
- Al conectar, Claude da un error y no llega a abrir la pantalla de permiso de la plataforma. Casi siempre es que en «OAuth client» quedó elegida «Use Claude's published identity». Quita el conector y vuelve a añadirlo eligiendo «Register automatically».
- Al confirmar una acción sale «La contraseña no era correcta o faltaba». Escribe tu contraseña de la plataforma, la misma con la que entras. Tras cinco fallos seguidos, espera unos minutos.
- Claude dice que, desde que confirmaste, ha cambiado lo que haría la acción. No se ha hecho nada. Pídele que la prepare otra vez y revisa la vista previa nueva.
- Claude dice que la conexión es de solo lectura. Es una conexión de antes de las acciones. Quita el conector y vuelve a conectarlo.
- Al abrir el enlace de confirmación sale «Esta acción no es tuya». La pidió el Claude de otro administrador. Solo esa persona puede confirmarla.
- Sale «Acción caducada». Pasaron 15 minutos. No se ha hecho nada. Pídeselo otra vez a Claude.
- Claude dice que ya confirmaste pero no hace nada. Dile que continúe: tiene que volver a llamar para hacerlo.
- Claude dice que Apify no está disponible o que el gasto está en pausa. Es el presupuesto del plan. Espera al siguiente ciclo o deja la acción para más tarde.
- Claude dice que ha llegado a un límite. Espera unos minutos, o al día siguiente si es un límite diario.
- Claude pide iniciar sesión otra vez. La conexión se revocó, caducó o se cortó al renovar el permiso. Conecta de nuevo. No se pierde ningún dato.
- No salen correos, teléfonos, fees ni EMV. Es lo normal. Pídelos de forma expresa.
