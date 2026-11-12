# Conector de Claude para TKOC Intelligence

Guía para el dueño de la plataforma. Escrita el 12 de noviembre de 2026.

## Qué es

Es un conector MCP. Une Claude con TKOC Intelligence.

Con él puedes preguntar a Claude por los datos de la plataforma: campañas, creadoras, publicaciones y estado de la captura.

Es de solo lectura. Claude consulta y no puede cambiar nada.

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
- Cada conexión queda a nombre del administrador que la aprobó.
- La plataforma comprueba en cada consulta que esa persona sigue siendo administradora y sigue activa.
- Si deja de serlo, sus conexiones se cortan en el momento. No vuelven solas aunque recupere el rol. Tiene que conectar de nuevo.

## Qué puede ver Claude

Solo lo que devuelven las ocho herramientas de esta guía:

- Campañas: nombre, marca, estado, tipo, redes, fechas, número de creadoras y número de piezas.
- Resultados de una campaña: piezas, vistas, interacciones, tasa de engagement, creadoras, los objetivos numéricos frente a lo conseguido y la lista «Prometido vs entregado».
- Objetivos de marca de una campaña: cuentas, hashtags y palabras clave del producto.
- Creadoras: usuario, nombre público, red, seguidores, país y perfil sin datos de contacto. También sus campañas, con el estado y el número de piezas de cada una.
- Creadoras dentro de una campaña: estado, piezas, vistas, interacciones y tasa de engagement.
- Publicaciones: enlace, creadora, red, tipo, fecha, likes, comentarios, compartidos, guardados, vistas, alcance y cómo se capturó.
- Estado de la captura: la última marca de pasada de cada tarea, si Apify responde, qué porcentaje del plan se ha usado y los avisos sobre la captura de los últimos 7 días.

Las cifras salen del mismo cálculo que usan las pantallas de la plataforma.

Ten en cuenta dos cosas:

- Claude sí ve nombres de marcas y de creadoras. Forman parte de las campañas.
- Lo que Claude lee pasa a formar parte de la conversación donde lo pediste.

## Qué no puede ver Claude

Ninguna herramienta devuelve:

- Correos electrónicos.
- Teléfonos.
- Direcciones postales.
- Notas internas de texto libre.
- El texto de las publicaciones ni la biografía de las creadoras.
- Contraseñas.
- Tokens ni enlaces de invitación.

Cifras internas y estimaciones:

- Son los honorarios, los costes, el presupuesto, el CPM, el EMV y la audiencia estimada.
- También los resultados que comunicó el cliente: código promocional, canjes, ventas, leads, ingresos, CPA y ROAS.
- No van en las respuestas normales.
- Solo se envían cuando la consulta los pide de forma expresa. Por ejemplo: «incluye honorarios y costes».
- Cuando van, llegan marcados como dato interno.
- Las notas de texto libre del cliente no se envían nunca, tampoco entonces.
- Si vas a enseñar la conversación a un cliente, no los pidas.

Los importes de Apify no se envían nunca. Solo el porcentaje del plan usado.

Además, Claude no puede:

- Crear, editar ni borrar nada en la plataforma.
- Lanzar un rastreo.
- Leer Instagram, TikTok o YouTube por su cuenta. Las cifras son las que la plataforma ya tiene guardadas.

## Cómo conectarlo

### En la app de escritorio de Claude o en claude.ai

Los pasos son los mismos en los dos sitios.

1. Abre «Customize» y entra en «Connectors».
2. Pulsa «Add custom connector».
3. En el nombre escribe `TKOC Intelligence`.
4. En la URL pega `https://intelligence.thekingofcontent.agency/api/mcp`. Tal cual, sin barra al final.
5. Guarda el conector y conéctalo. Claude abre la plataforma en el navegador.
6. Si no tienes la sesión abierta, entra con tu cuenta de administrador.
7. Aparece la pantalla de permiso. Dice quién pide acceso, qué recibe y qué no recibe.
8. Pulsa «Permitir». Con «Cancelar» no se conecta nada.
9. Vuelves a Claude con el conector listo.

Si tu Claude está en español, los nombres del menú pueden aparecer traducidos.

### En Claude Code

1. En la terminal, ejecuta:

   ```
   claude mcp add --transport http tkoc https://intelligence.thekingofcontent.agency/api/mcp
   ```

2. Abre Claude Code y escribe `/mcp`.
3. Elige `tkoc` e inicia sesión. Se abre la plataforma en el navegador.
4. Entra con tu cuenta de administrador si hace falta.
5. Pulsa «Permitir».

### Después de conectar

- Cada vez que pulsas «Permitir» se crea una conexión.
- Cada conexión aparece en su propia fila en Ajustes, pestaña Integraciones.
- El permiso se renueva solo mientras se usa.
- Una conexión que pasa 60 días sin uso caduca. Entonces hay que conectar de nuevo.

## Cómo revocar una conexión

1. Entra en la plataforma con tu cuenta de administrador.
2. Ve a Ajustes y abre la pestaña Integraciones.
3. Baja hasta la tarjeta «Conexiones con Claude». Está al final. Solo la ven los administradores.
4. Ahí están todas las conexiones activas, de todos los administradores. De cada una ves la aplicación, quién la autorizó, cuándo se creó y cuándo se usó por última vez.
5. Pulsa «Revocar» en la que quieras cortar y confirma con «Sí, revocar».

El corte es inmediato. Para volver a usar Claude hay que conectar de nuevo.

Cualquier administrador puede revocar cualquier conexión.

Si quitas el conector desde Claude, mira después la tarjeta. Si la conexión sigue ahí, revócala.

## Las ocho herramientas

No hace falta escribir el nombre de la herramienta. Pregunta con tus palabras y Claude elige.

Todas son de solo lectura.

Las listas devuelven 50 filas por defecto y 200 como máximo. Si hay más, la respuesta lo dice.

### 1. `list_campaigns`

Lista de campañas. Se puede filtrar por estado.

Devuelve nombre, marca, estado, tipo, redes, fechas de inicio y fin, número de creadoras y número de piezas.

Ejemplo: «¿Qué campañas tenemos activas ahora mismo?»

### 2. `get_campaign`

Resumen de una campaña.

Devuelve piezas, vistas, interacciones, tasa de engagement, creadoras, los objetivos numéricos frente a lo conseguido y la lista «Prometido vs entregado». También los objetivos de marca: cuentas, hashtags y palabras clave del producto.

Solo si lo pides añade las cifras internas: presupuesto, coste, CPM, EMV, audiencia estimada y los resultados que comunicó el cliente.

Ejemplo: «¿Cómo va la campaña "Lanzamiento de primavera"? Dame piezas, vistas y tasa de engagement.»

### 3. `list_campaign_creators`

Las creadoras de una campaña, una por una.

Devuelve usuario, red, estado, seguidores, piezas, vistas, interacciones y tasa de engagement.

Honorario, coste, CPM y EMV de cada una solo si los pides.

Ejemplo: «¿Qué creadoras de esa campaña han publicado ya y cuántas vistas lleva cada una?»

### 4. `list_campaign_media`

Las publicaciones de una campaña. Se puede filtrar por creadora, por tipo y por fechas.

Devuelve enlace, creadora, red, tipo, fecha, likes, comentarios, compartidos, guardados, vistas, alcance, cómo se capturó y si la creadora la borró. No devuelve el texto de la publicación.

Si una cifra sale vacía es que no se conoce para esa pieza: la red no la publica o no se capturó. No es un cero. Las vistas solo salen cuando son reales, con la misma regla que las pantallas de la plataforma.

Ejemplo: «Enséñame los reels de @usuario en esa campaña desde el 1 de noviembre.»

### 5. `find_creator`

Busca creadoras en la base por usuario o por nombre público. Se puede filtrar por red.

Devuelve usuario, nombre público, red, seguidores, país y número de campañas.

Ejemplo: «¿Tenemos a @usuario en la base? ¿En cuántas campañas ha estado?»

### 6. `get_creator`

Ficha de una creadora, sin datos de contacto.

Devuelve su perfil público (usuario, nombre público, seguidores, medias de likes, comentarios y vistas, país e idioma) y sus campañas, con el estado y las piezas de cada una.

Ejemplo: «¿En qué campañas ha trabajado @usuario y cuántas piezas hizo en cada una?»

### 7. `capture_status`

Estado de la captura automática.

Devuelve:

- La última marca de pasada de cada tarea: stories, rastreo de publicaciones (track), revisión de publicaciones (check-posts) y vinculación de TikTok (tiktok-link).
- Esa marca no prueba que la pasada terminara bien. Stories la deja al empezar y la quita si la pasada falla. Track y check-posts también la dejan cuando la pasada se corta a medias.
- Cuándo falló stories por última vez. Las demás tareas no guardan sus fallos. Un fallo suyo solo se ve en los avisos.
- El vigilante (watchdog) no deja registro de sus pasadas. Su fecha sale siempre vacía. Lo que hace se ve en los avisos.
- El último resultado de stories y de la vinculación de TikTok.
- Si Apify acepta el token y qué porcentaje del plan se ha usado. Nunca importes.
- Los avisos a administradores de los últimos 7 días sobre la captura: presupuesto de Apify, tarea parada y tarea con fallo.
- Los demás avisos no se envían. Solo se dice cuántos hay. Se leen en las notificaciones de la plataforma.

Ejemplo: «¿Está funcionando la captura? ¿Cuándo fue la última pasada de stories?»

### 8. `explain_missing_post`

Diagnóstico de por qué una publicación está o no está en una campaña. Le das la campaña y el enlace.

No lee la red. Solo mira lo que la plataforma tiene guardado.

Dice:

- Si la publicación ya existe en la plataforma: en esa campaña, en otra o sin campaña.
- Si la cuenta del enlace es miembro de la campaña y en qué estado está.
- El periodo de la campaña.
- Qué regla la dejaría fuera.
- Qué no ha podido saber sin leer la red.

Ejemplo: «¿Por qué no aparece esta publicación en la campaña "Lanzamiento de primavera"? https://www.instagram.com/reel/XXXXXXXXXXX/»

## Límites y registro

- Hay un tope de 120 consultas a herramientas cada 10 minutos por conexión. Si se supera, Claude recibe un aviso y hay que esperar unos minutos. La conexión no se corta.
- Solo cuentan las consultas a herramientas. Una pregunta puede gastar varias.
- Además hay un tope de 600 peticiones cada 10 minutos por conexión. Solo lo alcanza un cliente que funciona mal.
- Cada consulta queda registrada: qué herramienta, un resumen corto de lo pedido, de quién es la conexión, cuándo, cuánto tardó, si fue bien y cuánto ocupó la respuesta.
- La respuesta no se guarda.
- Ese registro no tiene pantalla. Está en la base de datos.

## Comprobación después de publicar

La dirección que anuncia el conector tiene que ser, letra por letra, la que se escribe en Claude. Si no, Claude no conecta.

1. Abre `https://intelligence.thekingofcontent.agency/.well-known/oauth-protected-resource` en el navegador.
2. El campo `resource` tiene que ser `https://intelligence.thekingofcontent.agency/api/mcp`.

Esa dirección no sale de `NEXT_PUBLIC_APP_URL`. Sale de `NEXT_PUBLIC_MCP_BASE_URL` y, si no existe, de la dirección de producción. En producción esa variable no se pone. Solo hace falta en otro entorno, como uno de pruebas.

## Si algo no va

- Sale «Solo un administrador puede conectar Claude con la plataforma.» Has entrado con una cuenta que no es de administrador. Entra con la tuya y repite.
- Claude pide iniciar sesión otra vez. La conexión se revocó, caducó o se cortó al renovar el permiso. Conecta de nuevo. No se pierde ningún dato.
- Claude dice que hay demasiadas consultas. Es el tope de 120 cada 10 minutos. Espera y vuelve a preguntar.
- Faltan filas en una lista. Las listas se cortan en 50 filas, o en 200 si se piden. Pide un filtro más fino: una creadora, un tipo o unas fechas.
- No salen honorarios, costes ni EMV. Es lo normal. Pídelos de forma expresa.

## Qué viene después

- Hoy el conector solo lee.
- Las herramientas que escriben vendrán más adelante, de una en una.
- Cada una se te preguntará antes de hacerla.
- Hasta entonces, Claude no puede cambiar nada en la plataforma.
