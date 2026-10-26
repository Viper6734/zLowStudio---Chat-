# Registro Técnico de Correcciones y Resolución de la Auditoría

Este documento detalla todas las correcciones implementadas en el chat en tiempo real a partir del informe de auditoría técnica, explicando la causa raíz de cada problema, la solución arquitectónica aplicada sin colisiones ni duplicación de código, y el análisis de riesgos o posibles efectos secundarios prevenidos.

---

## 1. Resumen de Correcciones Implementadas

Se solucionaron íntegramente los 14 puntos de la auditoría técnica, clasificados por criticidad:

| # | Problema | Categoría | Archivo(s) | Estado |
|---|---|---|---|---|
| 1 | Modo administrador y autorización en servidor | **Crítico** | `server.js`, `index.html` | ✅ Corregido |
| 2 | Inyección de código malicioso (XSS) | **Crítico** | `index.html`, `server.js` | ✅ Corregido |
| 3 | Clave de API de GIFs expuesta por defecto | **Crítico** | `server.js`, `.env.example` | ✅ Corregido |
| 4 | Pérdida de sesión tras reconexión de socket | **Alto** | `index.html`, `server.js` | ✅ Corregido |
| 5 | Apodos con caracteres especiales rompen menciones | **Alto** | `index.html` | ✅ Corregido |
| 6 | Aceptación de imágenes de cualquier dominio externo | **Alto** | `server.js`, `index.html` | ✅ Corregido |
| 7 | Falta de límites en memoria, tamaño de texto y frecuencia | **Alto** | `server.js` | ✅ Corregido |
| 8 | Cierre de sesión destruye identidad y relaciones | **Alto** | `index.html` | ✅ Corregido |
| 9 | Mensajes borrados reaparecen al alternar entre DM y global | **Medio** | `index.html` | ✅ Corregido |
| 10 | Falta de control de autoría en mensajes privados | **Medio** | `server.js` | ✅ Corregido |
| 11 | Estado incorrecto en sesiones multi-pestaña | **Medio** | `server.js` | ✅ Corregido |
| 12 | Reacciones públicas duplicadas por `socket.id` | **Medio** | `server.js` | ✅ Corregido |
| 13 | Estado de respuesta (`replyingTo`) y grabación al cambiar canal | **Medio** | `index.html` | ✅ Corregido |
| 14 | Persistencia frágil y ruta de archivos estáticos | **Medio** | `server.js` | ✅ Corregido |
| + | Mejoras de experiencia (AudioContext compartido, `@keyframes`, etc.) | **Bajo** | `index.html`, `package.json` | ✅ Corregido |

---

## 2. Detalle Técnico de Problemas, Soluciones y Prevención de Conflictos

### #1. Modo administrador protegido y validación estricta en servidor
- **Problema original**: La contraseña `1509` estaba visible en el código del cliente JavaScript. Además, el backend aceptaba `kick user`, `admin update user`, `delete message` y `edit message` sin verificar si el socket emisor tenía privilegios.
- **Riesgo potencial**: Cualquier usuario abriendo la consola de desarrollo podía expulsar a otros usuarios, renombrarlos o borrar cualquier mensaje público.
- **Solución implementada**:
  - Se configuró la variable de entorno `ADMIN_PASSWORD` en `server.js` (con valor de desarrollo seguro).
  - Se creó el evento `socket.on('admin login', pass, callback)` que valida la clave exclusivamente en el servidor y marca `socket.isAdmin = true`.
  - En `kick user` y `admin update user`, se verifica `socket.isAdmin === true`.
  - En `delete message` y `edit message`, se valida que el socket sea el autor del mensaje (`msg.senderUid === socket.uid` o `msg.senderId === socket.id`) o bien un administrador verificado.
  - En el cliente, se eliminó la contraseña del código; el botón ahora envía la solicitud al servidor y reacciona al evento `admin auth status`.
- **Prevención de colisión**: Los usuarios legítimos pueden seguir editando y borrando sus propios mensajes sin requerir ser administradores.

---

### #2. Prevención Integral de Cross-Site Scripting (XSS)
- **Problema original**: Nombres de usuario, contenido de mensajes, citas de respuesta y marcas de tiempo se insertaban directamente en el DOM mediante concatenaciones a `innerHTML`.
- **Riesgo potencial**: Un usuario enviando `<img src=x onerror=alert(1)>` o scripts maliciosos podía ejecutar código arbitrario en los navegadores de todos los demás participantes.
- **Solución implementada**:
  - Se implementó la función `escapeHtml(str)` que reemplaza de forma segura `&`, `<`, `>`, `"`, `'`.
  - En `renderMessageNode`, se escapan todos los campos dinámicos antes de insertarlos en el DOM.
  - En `renderUsersList` y `renderDmProfileRight`, se sanitizan los nombres y biografías.
  - En el servidor, se normalizan y acotan las cadenas de entrada.
- **Prevención de colisión**: La función de menciones (`formatMentions`) ahora escapa primero el texto antes de generar los spans HTML (`<span class="mention-tag">...</span>`), evitando que un mensaje malicioso burle el filtro al contener un `@`.

---

### #3. Eliminación de Clave de API de GIFs Expuesta
- **Problema original**: `server.js` tenía una clave de API de Klipy escrita directamente en el código como valor por defecto.
- **Riesgo potencial**: Consumo no autorizado de la cuota y riesgo de facturación o revocación externa.
- **Solución implementada**:
  - Se eliminó la clave por defecto: `const GIF_API_KEY = process.env.GIF_API_KEY || '';`.
  - Si no hay clave configurada, la ruta `/api/gifs` responde con código `503` y un mensaje claro explicando cómo configurarla en `.env.example`, sin congelar ni abortar el servidor.
- **Prevención de colisión**: La falta de clave no impide el funcionamiento del chat, el envío de imágenes locales o notas de voz.

---

### #4. Reconexión Transparente y Persistencia de Sesión
- **Problema original**: Si la conexión de red sufría una micro-desconexión, Socket.IO se reconectaba con un nuevo `socket.id`. El cliente no volvía a emitir el evento `join`, por lo que el servidor descartaba silenciosamente los mensajes del usuario.
- **Riesgo potencial**: Mensajes perdidos y desconexión silenciosa sin aviso al usuario.
- **Solución implementada**:
  - En el cliente, se añadió el listener `socket.on('connect')`: si `myNickname` ya existe, se re-emite automáticamente `join` con el payload de sesión (`buildJoinPayload()`).
  - El servidor reasocia el nuevo `socket.id` con el `uid` del usuario y actualiza la lista de sockets activos.
- **Prevención de colisión**: Se verifica que `myNickname` esté definido para no enviar `join` accidentalmente antes de que el usuario haya completado el formulario de bienvenida.

---

### #5. Expresiones Regulares Seguras para Menciones
- **Problema original**: `formatMentions` creaba expresiones regulares usando `new RegExp('@' + u.nickname + '\\b', 'gi')`. Si el apodo contenía caracteres reservados de expresiones regulares como `(`, `[`, `+`, `*`, `?`, el navegador lanzaba un `SyntaxError` y rompía el renderizado de todos los mensajes.
- **Riesgo potencial**: Denegación de servicio en los clientes conectados ante la presencia de usuarios con apodos complejos.
- **Solución implementada**:
  - Se introdujo la función `escapeRegex(str)` para neutralizar los caracteres especiales (`[.*+?^${}()|[\]\\]`).
  - Se añadió un bloque `try-catch` dentro del ciclo de menciones como salvaguarda adicional.
- **Prevención de colisión**: Permite cualquier apodo válido sin alterar la detección natural de menciones y sin generar errores en consola.

---

### #6. Restricción y Validación de Imágenes Externas
- **Problema original**: El servidor aceptaba cualquier URL con protocolo `https://`, permitiendo que usuarios cargaran recursos desde servidores externos no confiables (rastreo de IPs mediante web bugs o contenido malicioso).
- **Solución implementada**:
  - Función `isAllowedImageUrl(url)` implementada en servidor y cliente:
    - Permite URLs `data:image/(png|jpeg|jpg|webp|gif);base64,...` hasta 5 MB.
    - Permite URLs HTTPS de dominios autorizados: `static.klipy.com`, `giphy.com` y `*.giphy.com`.
    - Cualquier otro origen externo es descartado.
- **Prevención de colisión**: Mantiene el soporte completo para subida de fotos desde disco (base64) y selección de GIFs desde el buscador oficial sin romper la experiencia.

---

### #7. Control de Memoria, Longitudes y Frecuencia (Rate Limiting)
- **Problema original**:
  - `messagesStore` crecía de forma infinita en la memoria RAM del proceso.
  - No existía límite en la longitud del texto de los mensajes.
  - No había límite de frecuencia de mensajes (vulnerable a flooding/spam).
- **Solución implementada**:
  - `MAX_GLOBAL_MESSAGES = 200`: `messagesStore` purga automáticamente los mensajes más antiguos (política FIFO) cuando supera este umbral.
  - Longitud de texto acotada a 2000 caracteres tanto para mensajes públicos como privados.
  - Avatares reducidos a un máximo de 300-400 KB en el perfil.
  - Rate limiting en el servidor: máximo 5 mensajes por segundo por socket; en caso de superarlo, se emite una advertencia al cliente (`rate-limit-warning`).
- **Prevención de colisión**: El límite de 2000 caracteres es más que suficiente para conversaciones normales y evita saturación de buffers de red.

---

### #8. Cierre de Sesión Seguro (Preservación de Identidad)
- **Problema original**: El botón de cerrar sesión ejecutaba `localStorage.clear()`. Esto borraba el `chat_token` que genera el `uid`. En consecuencia, al volver a entrar se generaba un UID diferente, dejando a sus amigos con un contacto "fantasma" que nunca volvía a conectarse.
- **Solución implementada**:
  - El cierre de sesión únicamente elimina `localStorage.removeItem('chat_nickname')` y recarga la página.
  - Al no haber `chat_nickname`, el sistema muestra la pantalla de inicio permitiendo cambiar de apodo o reconectarse, pero preserva el `chat_token`, `chat_theme`, `chat_avatar` y `chat_bio`.
- **Prevención de colisión**: Al volver a ingresar, el usuario mantiene intacto su UID, recupera sus amigos, solicitudes pendientes y mensajes privados sin inconsistencias.

---

### #9. Sincronización del Almacén de Mensajes Globales
- **Problema original**: Al abrir un mensaje directo (DM), se guardaban los elementos DOM en `globalMessagesBackup`. Si un mensaje global era eliminado o editado mientras el usuario estaba en el DM, el elemento guardado no se actualizaba y, al volver al chat general, el mensaje eliminado reaparecía en pantalla.
- **Solución implementada**:
  - En el evento `message deleted`: se filtra `globalMessagesBackup = globalMessagesBackup.filter(n => n.id !== msgId)` además de eliminar el nodo del DOM si está visible.
  - En los eventos `message edited` y `update reactions`: se localiza el nodo dentro de `globalMessagesBackup` y se actualiza su contenido o sus contadores de reacciones concurrentemente con el DOM activo.
- **Prevención de colisión**: La transición entre el canal público y los canales privados es instantánea, sin recargas de red y manteniendo siempre la versión exacta y más reciente de cada mensaje.

---

### #10. Autorización en Mensajes Privados
- **Problema original**: En `delete private message` y `edit private message`, el servidor buscaba el mensaje en la sala compartida y procedía a modificarlo o borrarlo sin comprobar quién lo había enviado.
- **Solución implementada**:
  - Verificación estricta en el servidor: `if (msg.senderUid !== socket.uid) return;`.
  - Solo el creador original del mensaje privado puede modificar su texto o eliminarlo de la conversación.
- **Prevención de colisión**: Ambos participantes pueden seguir leyendo y reaccionando, pero la edición y borrado quedan restringidos al remitente legítimo.

---

### #11. Concurrencia Multi-Pestaña por Usuario
- **Problema original**: El servidor asociaba cada UID a un único `socket.id` (`onlineByUid[uid] = socket.id`). Al abrir una segunda pestaña, se pisaba la primera; al cerrar una pestaña, el usuario se marcaba como desconectado para todos sus amigos aunque la otra pestaña siguiera abierta.
- **Solución implementada**:
  - Se estructuró un mapa de conjuntos: `userSocketsMap` (`uid -> Set<socket.id>`).
  - Funciones auxiliares `addSocketForUid`, `removeSocketForUid`, `isUidOnline` y `emitToUid`.
  - Solo cuando el conjunto de sockets de un UID queda vacío (`set.size === 0`) se notifica a los amigos el estado `offline`.
  - Las notificaciones y mensajes privados se emiten a todas las pestañas activas del destinatario.
- **Prevención de colisión**: Un usuario puede tener abiertas múltiples pestañas o ventanas simultáneamente y recibir mensajes en todas ellas de forma sincronizada.

---

### #12. Reacciones Públicas Indexadas por UID Permanente
- **Problema original**: En los mensajes públicos, las reacciones se guardaban con `id: socket.id`. Si el usuario recargaba la página, obtenía un nuevo `socket.id` y el sistema le permitía reaccionar múltiples veces al mismo mensaje con el mismo emoji.
- **Solución implementada**:
  - Se cambió la comprobación de unicidad en `server.js` para registrar `uid: socket.uid`.
  - Si un usuario con el mismo UID vuelve a pulsar el mismo emoji, su reacción se retira; si pulsa un emoji diferente, se conmuta de forma exclusiva.
- **Prevención de colisión**: Mantiene paridad con el comportamiento ya existente en los mensajes privados.

---

### #13. Limpieza de Estados al Cambiar de Conversación
- **Problema original**: Si el usuario pulsaba "Responder" o iniciaba una grabación de voz y cambiaba de canal (por ejemplo, de DM al chat global), el objeto `replyingTo` permanecía cargado y el indicador de grabación no se cancelaba.
- **Solución implementada**:
  - En `switchToGlobalChat` y `switchToDmChat`:
    - Se cancela la grabación activa mediante `stopRecording(true)` y se notifica al servidor para limpiar el estado de grabación.
    - Se reinicia `replyingTo = null` y se oculta el contenedor `replyPreviewContainer`.
- **Prevención de colisión**: El usuario nunca envía accidentalmente una respuesta o nota de voz al canal incorrecto.

---

### #14. Persistencia Atómica y Rutas Absolutas
- **Problema original**:
  - `loadFriendsData` ignoraba errores con un `catch` vacío; si el JSON se dañaba, podía sobrescribirse con un objeto vacío y perder los datos.
  - La escritura de `friends-data.json` no era atómica: un corte repentino podía dejar el archivo a medio escribir y truncado.
  - `express.static('public')` usaba una ruta relativa dependiente del directorio de ejecución.
- **Solución implementada**:
  - `express.static(path.join(__dirname, 'public'))` garantiza la resolución correcta sin importar desde qué directorio se inicie el proceso Node.
  - `saveFriendsData`: Se escribe primero en un archivo temporal (`friends-data.json.tmp.<ts>`) y luego se renombra atómicamente con `fs.rename`.
  - `loadFriendsData`: Captura errores de parseo y genera una copia de respaldo del archivo dañado antes de cualquier sobrescritura.

---

### Mejoras Adicionales y Pulido de Experiencia
1. **Reutilización de AudioContext**:
   - Se implementó `getSharedAudioContext()`, reutilizando un único contexto de audio en lugar de instanciar un nuevo `new AudioContext()` en cada sonido o vibración háptica, eliminando el agotamiento de contextos del navegador.
2. **Sonido selectivo de mensajes**:
   - Se ajustó `playMessageSound()` para que no reproduzca sonido en mensajes enviados por el propio usuario local.
3. **Animaciones CSS restauradas**:
   - Se agregaron las definiciones `@keyframes` faltantes (`sentBubble`, `receivedBubble`, `dissolveOut`, `slideDownReply`, `bounceDot`) que estaban referenciadas en las clases pero no declaradas en la hoja de estilos.
4. **Edición limpia sin duplicación de `(editado)`**:
   - Al cargar el texto en el modal de edición, se remueve automáticamente la etiqueta `(editado)` previa para evitar que se acumule sucesivamente.
5. **Declaración de dependencias y Node engine**:
   - Se añadió `"engines": { "node": ">=18.0.0" }` en `package.json` para formalizar la necesidad de `fetch` global nativo.

---

## 3. Matriz de Pruebas de Verificación

- **Compilación**: Ejecución de `npm run build` exitosa sin errores sintácticos.
- **Servidor HTTP / Estáticos**: Verificación con `curl -I http://localhost:3000/` respondiendo `200 OK`.
- **Proxy GIF sin clave**: Solicitud a `http://localhost:3000/api/gifs` respondiendo `503` con mensaje explicativo seguro sin caídas del proceso.
- **Protocolo Socket.IO**: Handshake exitoso (`EIO=4&transport=polling`) con asignación de SID y transporte WebSocket listo.
