# Reclamos de Pedidos — Farmacias

Portal web para que las farmacias reporten diferencias en pedidos (faltantes, sobrantes, cruces, averías, validación de inventario) y el equipo de atención les dé seguimiento (Pendiente → En revisión → Finalizado).

- **Frontend:** HTML/JS estático, publicado en GitHub Pages (sin build).
- **Backend:** Supabase (proyecto `tickets-farmacias`): login con código al correo, base de datos y seguridad por filas (RLS).

## Cómo funciona

| Rol | Qué hace |
|---|---|
| **Farmacia** (cualquier correo que no esté en la lista de atención) | Entra con código al correo, registra el nombre de su farmacia la primera vez, crea tickets y ve solo **sus** tickets y la respuesta de atención. |
| **Atención** (correos en la tabla `staff`) | Ve todos los tickets, filtra, cambia estatus, escribe una nota para la farmacia, exporta a Excel y administra el catálogo. |
| **Admin** (`staff.es_admin = true`) | Además, agrega/quita usuarios de atención. |

El ticket pide: tipo de reclamo, número de folio, fecha de recepción y uno o más productos (código → la descripción se llena sola desde el catálogo, cantidad). Si un código no existe en el catálogo, la farmacia puede escribir la descripción a mano.

Cada cambio de estatus queda en el historial del ticket con fecha y usuario.

## Configuración pendiente en Supabase (una sola vez)

Panel: https://supabase.com/dashboard/project/lcbyyvlqnnjmvhvfefij

1. **Plantilla del correo con código** — *Authentication → Emails → Templates*.
   En **Magic Link** y en **Confirm signup**, cambia el cuerpo por algo como:
   ```html
   <h2>Tu código de acceso</h2>
   <p>Ingresa este código en el portal de reclamos:</p>
   <p style="font-size:28px;letter-spacing:6px"><b>{{ .Token }}</b></p>
   <p>Vence en 1 hora. Si no lo pediste, ignora este correo.</p>
   ```
   (Sin `{{ .Token }}` Supabase manda un enlace en lugar de código.)
2. **SMTP propio** — *Authentication → Emails → SMTP Settings*.
   El correo incluido de Supabase **solo entrega a miembros de tu equipo de Supabase** y unos pocos por hora, así que para las farmacias necesitas un SMTP propio (Resend, Brevo, SendGrid, o Gmail/Outlook con contraseña de aplicación).
   Después sube el límite en *Authentication → Rate Limits* (correos por hora).
3. **URL del sitio** — *Authentication → URL Configuration*: pon la URL de GitHub Pages
   (ej. `https://omwiar.github.io/tickets-farmacias/`).

## Publicar en GitHub Pages

*Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/ (root)`*.

## Catálogo de productos

En la pestaña **Catálogo** (usuarios de atención) sube un `.xlsx` o `.csv` con columnas `codigo` y `descripcion` (también reconoce `ItemCode`/`ItemName` de SAP). Si el código ya existe, se actualiza. Se cargaron 5 productos de ejemplo (`7501001`–`7501005`) que puedes borrar.

## Estructura de datos

- `staff` — usuarios de atención (`email`, `nombre`, `es_admin`)
- `farmacias` — perfil de cada farmacia (vinculado al usuario)
- `productos` — catálogo (`codigo`, `descripcion`)
- `tickets` — encabezado del reclamo (motivo, folio, fecha de recepción, estatus, nota de atención)
- `ticket_items` — productos del reclamo
- `ticket_historial` — bitácora de cambios de estatus

Los tickets se crean con la función `crear_ticket()` (todo o nada). Las farmacias no pueden modificar tickets; atención solo puede cambiar `estatus` y `nota_atencion`.

`config.js` contiene la clave *publishable* de Supabase: es pública por diseño; la seguridad la dan las políticas RLS.
