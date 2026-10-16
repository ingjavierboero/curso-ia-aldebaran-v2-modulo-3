# PRD-002: Aldebaran — Un sistema para gestión de clientes y pagos

## Contexto y Problema
Mi empresa vende Software as a Service. Hoy el proceso de cobro lo estoy llevando yo a mano, generando las facturas de cobro todos los meses, enviando a los clientes los emails con las facturas y los resúmenes de deuda y además después controlo los pagos cuando el cliente me envía por mail el cupón de pago.
Necesito un sistema que me permita gestionar la facturación y los cobros de manera automatizada, generando todos los meses las diferentes facturas, enviándoselas a los clientes por mail y controlando que el pago se haya realizado.

Para el MVP, la facturación se genera contra el **ambiente de homologación de ARCA** (no el ambiente productivo). Esto permite validar todo el circuito (generación, numeración, envío, formato) sin emitir comprobantes fiscales reales todavía. El pasaje a facturación real en producción queda para una fase posterior, una vez validado el flujo completo.

### Personas
- **Admin**: hoy soy yo (Javier) el único usuario del sistema, con perfil Admin, y gestiono todo (ABMs, confirmación de pagos, configuración).
- **Editor**: perfil pensado para incorporar en el futuro a alguien que administre clientes/productos/deudas sin acceso a la gestión de usuarios. Por ahora no tiene personas asignadas.
- **Consulta**: perfil pensado para incorporar en el futuro a alguien (por ejemplo un contador o un asistente administrativo) que necesite ver el estado de clientes y deudas sin poder modificarlos. Por ahora no tiene personas asignadas.
- **Evaluador**: persona que evalúa la app sin acceso a la API key de Anthropic, a los certificados de ARCA ni a las credenciales de Gmail. Necesita recorrer todo el circuito (facturación, envío, recepción y validación de comprobantes) con servicios simulados (modo mock).

## Objetivos
- El 100% de las facturas deben ser generadas (en homologación de ARCA) y enviadas a los clientes el día 15 de cada mes (o antes, si un Admin ejecuta la facturación manualmente) o, si el sistema no estaba funcionando ese día, el día en que vuelva a funcionar dentro del mismo mes (salvo los períodos cuya facturación un Admin canceló)
- El 100% de los pagos recibidos deben ser controlados por el sistema
- La intervención del usuario debe ser mínima, solamente para confirmar el pago de la factura o resolver casos de revisión manual
- La app debe poder evaluarse de punta a punta en modo mock, sin credenciales de ARCA, Anthropic ni Gmail

## Requerimientos Funcionales

### Definiciones
- **Sistema**: en este documento, "el sistema" es siempre Aldebaran.
- **Agente**: la parte del sistema que ejecuta los procesos automáticos (facturación, recordatorios de fin de mes, revisión de la casilla y validación de comprobantes) sin intervención de un usuario.
- **Producto**: cada software que la empresa vende a sus clientes por una cuota mensual. Es **Activo** o **Inactivo** (un producto desactivado pasa a Inactivo; un producto reactivado vuelve a Activo).
- Usuario: **Activo** o **Inactivo** (un usuario dado de baja pasa a Inactivo; un usuario reactivado vuelve a Activo). Sus datos son nombre, email, perfil y contraseña; inicia sesión con su email.
- Cliente: **Activo** o **Inactivo** (un cliente dado de baja pasa a Inactivo; un cliente reactivado vuelve a Activo).
- **Email de facturación**: la dirección de email registrada de un cliente. A ella se le envían los emails del cliente y con ella se identifican los emails que el cliente responde.
- **Casilla del sistema**: la casilla de email propia del sistema (GMAIL_USER; en modo mock, aldebaran-mock@gmail.com), desde la que se envían los emails y en la que se reciben las respuestas de los clientes.
- **Modo mock**: modo de funcionamiento que se activa con la variable de entorno MOCK_MODE=true, en el que el sistema simula ARCA, el LLM y el email (SMTP e IMAP) y trabaja sobre una base de datos propia, separada de la del modo real. Con cualquier otro valor, o sin la variable, el sistema usa los servicios reales.
- **Casilla simulada**: en modo mock, reemplaza a la casilla del sistema: guarda los emails que el sistema envía y los emails recibidos que carga un usuario.
- Factura:
  - **Pendiente de pago**: la factura fue generada, o un usuario la devolvió a este estado, y no tiene un comprobante válido. El agente sigue buscando su pago en la casilla.
  - **Pago recibido**: el agente validó un comprobante que cubre la factura; espera que un usuario lo analice.
  - **Revisión manual**: el agente recibió un comprobante del cliente pero no pudo validarlo; el caso requiere la decisión de un usuario.
  - **Pagada**: un usuario confirmó el pago y la factura queda saldada. Solo un usuario puede pasar una factura a este estado.
- **Motivo**: razón por la que una factura está en Revisión manual. Solo las facturas en Revisión manual tienen motivo.
- **Factura adeudada**: factura en estado Pendiente de pago o Revisión manual.
- **Deuda vigente**: un cliente tiene deuda vigente si tiene al menos una factura adeudada.
- **Cliente en revisión**: cliente con al menos una factura en Revisión manual.
- **Antigüedad de una factura**: la determina su período facturado (mes y año). Una factura de un período anterior es más antigua.
- **Período cancelado**: período (mes y año) cuya facturación un Admin canceló (RF-54) y no reactivó (RF-56).
- **Empresa emisora**: la empresa que emite las facturas. Sus datos se configuran según RF-91 y su CUIT es el de ARCA_CUIT.
- **Adjunto**: archivo adjunto a un email en formato imagen (JPEG, PNG, GIF o WebP) o PDF (RF-116, RF-117).
- **Comprobante**: adjunto que el LLM clasificó como "si".
- **Clasificación del email**: la que el agente le asigna a cada email con adjunto a partir de la de sus adjuntos (RF-123).
- **Coincidencia de monto**:
  - Para un email con un solo comprobante: una factura adeudada, o una combinación de varias facturas adeudadas del cliente, cuyo total es exactamente igual al monto del comprobante.
  - Para un email con varios comprobantes: un conjunto de facturas adeudadas del cliente que se puede repartir entre los comprobantes de modo que a cada comprobante le corresponda al menos una factura, ninguna factura corresponda a dos comprobantes y el total de las facturas de cada comprobante sea exactamente igual a su monto (**coincidencia por comprobante**). Dos repartos que usan el mismo conjunto de facturas son la misma coincidencia. Si no existe ninguna coincidencia por comprobante, es coincidencia de monto toda factura adeudada, o combinación de varias, cuyo total es exactamente igual a la suma de los montos de los comprobantes (**coincidencia por suma**).
- **Combinación más antigua**: entre varias coincidencias de monto, se ordenan las facturas de cada una de la más antigua a la más reciente y se elige la que contiene la factura más antigua; si empatan, se compara la siguiente, y así sucesivamente. La comparación termina cuando alguna de las coincidencias que se comparan se queda sin facturas. Si al terminar la comparación no queda una única coincidencia, no hay combinación más antigua.
- **Email validable**: email con clasificación "si" de un cliente con deuda vigente que no está en revisión, en el que se extrajeron el CUIT y el monto de todos sus comprobantes y todos esos CUIT coinciden con el del cliente.
- **Datos de usuarios**: el listado de usuarios y los datos de cada usuario (nombre, email, perfil y estado). El nombre del usuario que ejecutó una acción registrada (por ejemplo, un recordatorio manual o la revisión de un aviso) no se considera dato de usuarios y lo ven todos los perfiles.
- **Configuración**: el intervalo de revisión de la casilla, la hora de facturación, la hora de recordatorios, la cantidad de reintentos, la espera entre reintentos, el punto de venta de ARCA y los datos de la empresa emisora (RF-91).
- **Aviso**: email recibido de un remitente que no coincide con ningún cliente. Está **Pendiente** hasta que un usuario lo marca como **Revisado**.
- **Error de proceso**: registro que crea el agente cuando una operación automática (generación de una factura, envío del email de una factura o envío de un recordatorio automático) sigue fallando después del último reintento, o cuando falla la revisión de la casilla. Está **Pendiente** hasta que pasa a **Resuelto**, por un reintento manual exitoso o porque un Admin o Editor lo marca así.
- **Historial del cliente**: registro cronológico de todo lo ocurrido con un cliente: su alta, las modificaciones de sus datos, su baja y reactivación; la asignación y desasignación de productos; las facturas generadas; los emails enviados (facturas y recordatorios, automáticos y manuales); los emails recibidos desde su email de facturación con el resultado de su procesamiento; los cambios de estado de sus facturas; y sus errores de proceso. Cada evento tiene fecha y hora y el usuario o el agente que lo originó.
- **Interfaz de revisión**: pantalla donde los usuarios ven los pagos informados, los avisos y los errores de proceso, y donde resuelven las revisiones manuales.
- **Banner de alerta**: aviso visible en el dashboard principal. Hay tres: el banner de errores, que se muestra mientras haya al menos un error de proceso Pendiente; el banner de cotización, que se muestra hasta que un Admin o Editor confirma la cotización de respaldo usada; y el banner de certificado, que se muestra mientras el certificado de ARCA esté vencido, no se pueda leer o falten 30 días o menos para su vencimiento.

### Usuarios y perfiles
- RF-01: El sistema debe exigir que el usuario inicie sesión para acceder a cualquier pantalla o endpoint, excepto el inicio de sesión, la solicitud de recuperación de contraseña, la pantalla de cambio de contraseña con token y, mientras no exista ningún usuario, la pantalla de registro del primer Admin.
- RF-02: El sistema debe permitir iniciar sesión a un usuario Activo con su email y su contraseña.
- RF-03: El sistema debe permitir a un usuario autenticado cerrar su sesión.
- RF-04: Mientras no exista ningún usuario, el sistema debe mostrar, en lugar del inicio de sesión, una pantalla para registrar el primer usuario con su nombre, email y contraseña, que queda Activo y con perfil Admin.
- RF-05: Una vez que existe al menos un usuario, el sistema no debe permitir acceder a la pantalla de registro del primer Admin ni registrar usuarios por esa vía.
- RF-06: El sistema debe permitir a un usuario Admin ver todos los datos del sistema.
- RF-07: El sistema no debe mostrar el hash de las contraseñas a ningún perfil.
- RF-08: El sistema debe permitir a un usuario Admin realizar todas las acciones del sistema.
- RF-09: El sistema debe permitir a un usuario Editor ver todos los datos del sistema excepto los datos de usuarios.
- RF-10: El sistema debe permitir a un usuario Editor realizar todas las acciones del sistema excepto gestionar usuarios, modificar la configuración, cancelar o reactivar la facturación de un período y ejecutar la facturación manual ("Facturar ahora").
- RF-11: El sistema debe permitir a un usuario Consulta ver todos los datos del sistema excepto los datos de usuarios.
- RF-12: El sistema debe permitir a un usuario Consulta enviar recordatorios manuales desde el dashboard.
- RF-13: El sistema no debe permitir a un usuario Consulta modificar ningún registro, salvo enviar recordatorios manuales (RF-12) y cambiar su propia contraseña (RF-21).
- RF-14: El sistema debe permitir a un Admin dar de alta un usuario con su nombre, email, perfil y contraseña inicial; el usuario queda Activo.
- RF-15: El sistema no debe permitir dar de alta ni modificar un usuario con un email que ya tiene otro usuario, sin distinguir mayúsculas de minúsculas.
- RF-16: El sistema debe permitir a un Admin modificar el nombre y el email de un usuario.
- RF-17: El sistema debe permitir a un Admin modificar el perfil de un usuario.
- RF-18: El sistema debe permitir a un Admin dar de baja un usuario, que pasa a estado Inactivo.
- RF-19: El sistema debe permitir a un Admin reactivar un usuario Inactivo, que pasa a estado Activo.
- RF-20: El sistema debe rechazar cualquier acción que deje al sistema sin ningún usuario Admin Activo (dar de baja al único Admin Activo o cambiarle el perfil).

### Contraseñas
- RF-21: El sistema debe permitir a un usuario autenticado de cualquier perfil cambiar su propia contraseña desde su perfil, ingresando la contraseña actual y la nueva.
- RF-22: El sistema debe rechazar cualquier contraseña de menos de 8 caracteres, tanto al registrar el primer Admin y al dar de alta un usuario como al cambiar la contraseña desde el perfil o desde la recuperación.
- RF-23: El sistema debe permitir solicitar la recuperación de la contraseña desde la pantalla de inicio de sesión, ingresando el email del usuario.
- RF-24: Cuando se solicita la recuperación para el email de un usuario Activo, el sistema debe enviarle un email con una URL que contiene un token de recuperación.
- RF-25: Al solicitar la recuperación, el sistema debe mostrar el mismo mensaje de confirmación tanto si el email corresponde a un usuario Activo como si no.
- RF-26: El sistema debe invalidar el token de recuperación a los 10 minutos del envío del email.
- RF-27: El sistema debe invalidar el token de recuperación una vez que se usó para cambiar la contraseña.
- RF-28: Al enviar un nuevo token de recuperación a un usuario, el sistema debe invalidar los tokens de recuperación anteriores de ese usuario.
- RF-29: El sistema debe validar el token de recuperación al ingresar a la URL y al confirmar la nueva contraseña.
- RF-30: Si el token no es válido (inexistente, vencido o ya usado), el sistema debe mostrar un mensaje de error.
- RF-31: A los 5 segundos de mostrar el mensaje de error de RF-30, el sistema debe redirigir al inicio de sesión.
- RF-32: Si el token es válido al ingresar a la URL, el sistema debe mostrar la pantalla de cambio de contraseña.
- RF-33: Una vez cambiada la contraseña con el token, el sistema debe redirigir al inicio de sesión.

### Clientes
- RF-34: El sistema debe permitir dar de alta un cliente con su razón social, CUIT, email de facturación y condición frente al IVA, todos obligatorios; el cliente queda Activo.
- RF-35: El sistema debe permitir modificar la razón social, el CUIT, el email de facturación y la condición frente al IVA de un cliente.
- RF-36: El sistema debe permitir dar de baja un cliente, que pasa a estado Inactivo.
- RF-37: El sistema debe permitir reactivar un cliente Inactivo, que pasa a estado Activo.
- RF-38: El sistema debe admitir como condición frente al IVA de un cliente solo los valores que ARCA admite para el receptor de una Factura C: IVA Responsable Inscripto (1), IVA Sujeto Exento (4), Consumidor Final (5), Responsable Monotributo (6), Sujeto No Categorizado (7), Proveedor del Exterior (8), Cliente del Exterior (9), IVA Liberado – Ley N° 19.640 (10), Monotributista Social (13), IVA No Alcanzado (15) y Monotributo Trabajador Independiente Promovido (16).
- RF-39: El sistema no debe permitir dar de alta ni modificar un cliente con un CUIT cuyo dígito verificador no es válido.
- RF-40: El sistema no debe permitir dar de alta ni modificar un cliente con un CUIT que ya tiene otro cliente.
- RF-41: El sistema no debe permitir dar de alta ni modificar un cliente con un email de facturación que ya tiene otro cliente, sin distinguir mayúsculas de minúsculas.

### Productos
- RF-42: El sistema debe permitir dar de alta un producto con su nombre y el precio de su cuota mensual.
- RF-43: El sistema debe permitir que el precio de cada producto se fije en pesos o en dólares.
- RF-44: El sistema no debe permitir dar de alta ni modificar un producto con un precio igual o menor a cero.
- RF-45: El sistema debe permitir modificar el nombre de un producto.
- RF-46: El sistema debe permitir modificar el precio de un producto.
- RF-47: El sistema debe permitir desactivar un producto, que pasa a estado Inactivo.
- RF-48: El sistema debe permitir reactivar un producto Inactivo, que pasa a estado Activo.
- RF-49: El sistema debe permitir asignar uno o varios productos Activos a un cliente.
- RF-50: El sistema debe permitir desasignar un producto de un cliente.

### Facturación
- RF-51: El agente debe generar el día 15 de cada mes, a la hora de facturación (11:00 por defecto), contra el ambiente de homologación de ARCA, una factura C por cada cliente Activo con al menos un producto Activo asignado, con el detalle de la cuota mensual de cada producto Activo asignado.
- RF-52: Si el sistema no estaba en funcionamiento el día 15 a la hora de facturación, el agente debe ejecutar el proceso de facturación del período apenas vuelva a funcionar, siempre que sea dentro del mismo mes.
- RF-53: Si el proceso de facturación de un período quedó interrumpido (por ejemplo, por un reinicio del sistema), el agente debe retomarlo apenas vuelva a funcionar, sin generar facturas duplicadas (RF-74, RF-75).
- RF-54: El sistema debe permitir a un Admin cancelar la facturación del período del mes en curso mientras el proceso de facturación de ese período no haya empezado.
- RF-55: El agente no debe ejecutar el proceso de facturación de un período cancelado, aunque se cumplan las condiciones de RF-51 o RF-52.
- RF-56: El sistema debe permitir a un Admin reactivar la facturación de un período cancelado mientras siga siendo el mes de ese período.
- RF-57: Si al reactivar la facturación de un período (RF-56) ya pasó la hora de facturación del día 15, el agente debe ejecutar el proceso de facturación de ese período apenas se reactiva.
- RF-58: El sistema debe permitir a un Admin ejecutar, con el botón "Facturar ahora", el proceso de facturación del período del mes en curso, con las mismas reglas que el proceso del día 15.
- RF-59: Si el proceso de facturación del período del mes en curso ya se ejecutó con "Facturar ahora" (RF-58), el agente no debe volver a ejecutarlo ese mes, ni el día 15 ni según RF-52; solo debe retomarlo si quedó interrumpido (RF-53).
- RF-60: Mientras el período del mes en curso esté cancelado, el sistema debe deshabilitar el botón "Facturar ahora" e indicar que está deshabilitado porque la facturación del mes está cancelada.
- RF-61: Mientras el proceso de facturación del período del mes en curso esté en ejecución, o una vez que terminó (se intentó generar la factura de todos los clientes facturables), el sistema debe deshabilitar el botón "Facturar ahora" e indicar el motivo: "facturación en curso" o "facturación del mes ya realizada".
- RF-62: El sistema debe permitir a un Admin configurar la hora de facturación con un valor entre 00:00 y 23:39.
- RF-63: Si un producto tiene el precio fijado en dólares, el agente debe facturarlo en pesos usando la cotización del dólar blue venta publicada en dolarhoy.com al momento de facturar.
- RF-64: Al facturar en pesos un producto con precio en dólares (RF-63), el agente debe redondear el importe en pesos de esa cuota al centavo más cercano.
- RF-65: El agente debe registrar, con su valor, fuente y fecha de lectura, cada cotización que lee de dolarhoy.com.
- RF-66: Para RF-67, el agente debe tomar como última cotización registrada la de fecha de lectura más reciente.
- RF-67: Si al facturar dolarhoy.com no responde o no se puede leer la cotización, y hay al menos una cotización registrada, el agente debe usar la última cotización registrada (RF-66).
- RF-68: Si al facturar dolarhoy.com no responde o no se puede leer la cotización, y no hay ninguna cotización registrada, el agente no debe generar la factura de los clientes que tienen al menos un producto con precio en dólares.
- RF-69: Cuando se aplica RF-67, el sistema debe mostrar el banner de cotización con la cotización usada y su fecha.
- RF-70: El sistema debe permitir a un Admin o Editor confirmar, desde el banner de cotización, la cotización de respaldo usada.
- RF-71: El agente debe emitir todas las facturas como comprobante tipo Factura C.
- RF-72: El agente debe emitir las facturas en el punto de venta de ARCA configurado.
- RF-73: El sistema debe permitir a un Admin configurar el punto de venta de ARCA con un número entero entre 1 y 99999.
- RF-74: El agente no debe generar más de una factura por cliente y período, aunque el proceso de facturación se ejecute más de una vez en el mismo mes.
- RF-75: El agente no debe emitir dos comprobantes en ARCA para la misma factura.
- RF-76: Si en un intento de generación ARCA autorizó la factura pero el agente no recibió la respuesta (por ejemplo, por un timeout), en el intento siguiente el agente debe registrar la factura con el número y el CAE que ARCA ya otorgó, en vez de solicitar otro comprobante.
- RF-77: El agente debe informar a ARCA, en cada factura, la condición frente al IVA que tiene el cliente al momento de facturar.
- RF-78: El agente debe registrar en cada factura la condición frente al IVA que informó a ARCA.
- RF-79: El agente debe asignar como fecha de emisión de la factura el día en que la genera (hora de Argentina, RNF-12).
- RF-80: El agente debe asignar como período de servicio de la factura desde el primer hasta el último día del mes del período facturado.
- RF-81: El agente debe asignar como fecha de vencimiento del pago de la factura el último día del mes del período facturado o, si la factura se genera después de ese día (por ejemplo, en un reintento manual), la fecha de emisión.
- RF-82: Si un cliente no tiene cargada la condición frente al IVA (por ejemplo, un cliente registrado antes de que existiera ese dato), el agente no debe generar su factura.
- RF-83: Cuando se aplica RF-82, el agente debe tratar la generación como fallida (RF-171 y RF-174) con el mensaje "el cliente no tiene cargada la condición frente al IVA".
- RF-84: Una vez generada la factura, el agente debe enviarla por email, como archivo PDF adjunto (RF-93), al email de facturación del cliente, informando que tiene una deuda pendiente.
- RF-85: El agente debe enviar el email de cada factura apenas la genera, sin esperar a que se generen las de los demás clientes.
- RF-86: El agente debe reintentar el envío del email de una factura (RF-171) sin volver a generar la factura.
- RF-87: El agente no debe demorar la generación ni el envío de la factura de un cliente por los reintentos de otro cliente.
- RF-88: El email de la factura (RF-84) debe informar el número, el período, el importe y el vencimiento de la factura, y la deuda vigente total del cliente, que es la suma de sus facturas adeudadas, aclarando cuando incluye facturas anteriores.
- RF-89: El email de la factura (RF-84) debe pedirle al cliente que responda el email adjuntando el comprobante de pago.
- RF-90: Mientras el sistema facture en el ambiente de homologación de ARCA, el agente debe indicar en el PDF y en el email de cada factura que el comprobante fue emitido en homologación y no tiene validez fiscal.
- RF-91: El sistema debe permitir a un Admin configurar los datos de la empresa emisora: razón social, domicilio comercial, condición frente al IVA, número de ingresos brutos y fecha de inicio de actividades.
- RF-92: El agente debe incluir en el PDF de cada factura los datos de la empresa emisora configurados (RF-91) y su CUIT.
- RF-93: El agente debe adjuntar a todo email de factura (RF-84 y RF-177) un archivo PDF con la razón social, el CUIT y la condición frente al IVA del cliente, el tipo de comprobante, el punto de venta, el número, la fecha de emisión, el período facturado y su período de servicio, la fecha de vencimiento del pago, el detalle de cada cuota mensual, el total en pesos, el CAE y su fecha de vencimiento, y la cotización usada cuando algún ítem se facturó en dólares.
- RF-94: El sistema no debe generar facturas a un cliente que no tiene ningún producto Activo asignado.
- RF-95: El sistema no debe generar facturas a un cliente Inactivo.
- RF-96: El sistema no debe enviar ningún email a un cliente Inactivo.
- RF-97: Mientras el certificado de ARCA (ARCA_CERT_PATH) esté vencido o no se pueda leer, el sistema debe mostrar el banner de certificado indicando que no se puede realizar la facturación.
- RF-98: Cuando falten 30 días o menos para el vencimiento del certificado de ARCA, el sistema debe mostrar el banner de certificado con su fecha de vencimiento, avisando que hay que renovarlo.

### Control de pagos
- RF-99: El agente debe revisar la casilla del sistema cada 15 minutos (valor por defecto) para detectar respuestas de los clientes.
- RF-100: El sistema debe permitir a un Admin configurar el intervalo de revisión de la casilla con un valor entre 5 y 60 minutos.
- RF-101: El agente debe contar el intervalo de revisión de la casilla desde el inicio de la revisión anterior.
- RF-102: Si una revisión todavía está en curso cuando se cumple el intervalo, el agente debe esperar a que termine para iniciar la siguiente.
- RF-103: Si la revisión de la casilla falla, el agente debe registrar un error de proceso Pendiente de revisión de la casilla, salvo que ya haya uno Pendiente.
- RF-104: Mientras la casilla no esté disponible, el agente debe volver a intentar la conexión en cada intervalo de revisión.
- RF-105: Cuando la casilla vuelve a estar disponible, el agente debe procesar los emails recibidos durante la falla.
- RF-106: Cuando la casilla vuelve a estar disponible, el agente debe pasar a Resuelto el error de proceso de revisión de la casilla.
- RF-107: La primera vez que el agente revisa la casilla, debe procesar los emails recibidos desde el día en que se emitió la primera factura; los anteriores no se procesan.
- RF-108: En cada revisión posterior a la primera, el agente debe procesar solo los emails recibidos desde la revisión anterior.
- RF-109: El agente debe procesar cada email recibido una sola vez, identificándolo por su Message-ID, aunque lo vuelva a leer de la casilla (por ejemplo, después de una falla según RF-105).
- RF-110: El agente no debe procesar los emails cuyo remitente es la casilla del sistema.
- RF-111: El sistema debe validar que el remitente de cada email recibido coincida con el email de facturación de un cliente.
- RF-112: La comparación del remitente con el email de facturación de los clientes no debe distinguir mayúsculas de minúsculas.
- RF-113: Si el remitente no coincide con ningún cliente, el sistema debe registrar el email como un aviso Pendiente, sin disparar la validación de pago.
- RF-114: El sistema debe registrar en el historial del cliente cada email recibido desde su email de facturación.
- RF-115: El sistema debe considerar como posible comprobante solo los emails que traen al menos un adjunto; un email sin adjunto no dispara ninguna otra acción.
- RF-116: Para RF-115, el agente no debe considerar adjuntos las imágenes embebidas en el cuerpo del mensaje (por ejemplo, el logo de una firma).
- RF-117: Para RF-115, el agente debe considerar adjuntos solo los archivos en formato imagen (JPEG, PNG, GIF o WebP) o PDF, e ignorar los archivos de otros formatos.
- RF-118: El agente debe procesar los emails de un cliente Inactivo igual que los de un cliente Activo.
- RF-119: El agente debe usar un LLM para clasificar cada adjunto del email, junto con el cuerpo del email, como "si", "no" o "dudoso" según corresponda o no a un pago.
- RF-120: Por cada comprobante, el agente debe extraer el CUIT y el monto pagado.
- RF-121: El CUIT que el agente extrae de cada comprobante (RF-120) debe ser el de quien realizó el pago (ordenante u originante), nunca el del beneficiario.
- RF-122: Si el CUIT extraído de un comprobante no tiene 11 dígitos, el agente debe considerarlo no extraído (RF-132).
- RF-123: El agente debe asignar a cada email con adjunto una única clasificación, a partir de la de sus adjuntos y en este orden: procesamiento erróneo, si el procesamiento de al menos un adjunto quedó marcado como erróneo (RNF-02); si no, "dudoso", si al menos un adjunto es "dudoso"; si no, "si", si al menos un adjunto es "si"; si no, "no".
- RF-124: El agente debe registrar en el historial del cliente el resultado del procesamiento de cada email con adjunto: la clasificación de cada adjunto, el CUIT y el monto extraídos de cada comprobante, o la marca de procesamiento erróneo, y la clasificación del email (RF-123).
- RF-125: Al comparar el CUIT extraído de un comprobante con el del cliente, el agente debe considerar solo sus dígitos, sin tener en cuenta guiones, puntos ni espacios.

Las reglas RF-126 a RF-137 se aplican a cada email con adjunto de un cliente, según su clasificación (RF-123). Sus condiciones son excluyentes: a cada email le corresponde exactamente una de ellas.
- RF-126: Si la clasificación del email es "no", el agente no debe cambiar el estado de ninguna factura.
- RF-127: Si la clasificación del email es "si" o "dudoso", o su procesamiento es erróneo, y el cliente no tiene deuda vigente, el agente no debe cambiar el estado de ninguna factura.
- RF-128: Si la clasificación del email es "si" o "dudoso", o su procesamiento es erróneo, y el cliente está en revisión, el agente debe pasar todas sus facturas adeudadas a Revisión manual, sin validar el email. Motivo: "revisión manual pendiente".
- RF-129: Cuando se aplica RF-128, el motivo "revisión manual pendiente" debe reemplazar el motivo anterior de las facturas que ya estaban en Revisión manual.
- RF-130: Si el procesamiento del email es erróneo y el cliente tiene deuda vigente y no está en revisión, el agente debe pasar sus facturas adeudadas a Revisión manual. Motivo: "no se pudo procesar el comprobante".
- RF-131: Si la clasificación del email es "dudoso" y el cliente tiene deuda vigente y no está en revisión, el agente debe pasar sus facturas adeudadas a Revisión manual. Motivo: "clasificación dudosa".
- RF-132: Si la clasificación del email es "si", el cliente tiene deuda vigente y no está en revisión, y no se pudo extraer el CUIT o el monto de al menos un comprobante, el agente debe pasar sus facturas adeudadas a Revisión manual. Motivo: "no se pudieron extraer el CUIT o el monto".
- RF-133: Si la clasificación del email es "si", el cliente tiene deuda vigente y no está en revisión, se extrajeron el CUIT y el monto de todos los comprobantes, y el CUIT de al menos uno no coincide con el del cliente, el agente debe pasar sus facturas adeudadas a Revisión manual. Motivo: "CUIT no coincide".
- RF-134: Si el email es validable y tiene exactamente una coincidencia de monto, el agente debe pasar las facturas de esa coincidencia a Pago recibido.
- RF-135: Si el email es validable, tiene más de una coincidencia de monto y hay una combinación más antigua, el agente debe pasar las facturas de la combinación más antigua a Pago recibido.
- RF-136: Si el email es validable, tiene más de una coincidencia de monto y no hay una combinación más antigua, el agente debe pasar las facturas adeudadas del cliente a Revisión manual. Motivo: "no se pudo determinar qué facturas cancela el pago".
- RF-137: Si el email es validable y no tiene ninguna coincidencia de monto (por ejemplo, un pago parcial), el agente debe pasar las facturas adeudadas del cliente a Revisión manual. Motivo: "monto no coincide".

Reglas que acompañan a las anteriores:
- RF-138: Cada vez que el agente pasa facturas a Revisión manual, debe registrar el motivo indicado en la regla que lo disparó.
- RF-139: Cuando se aplica RF-128, el agente debe asociar el email nuevo a la revisión manual pendiente del cliente.
- RF-140: Cuando una factura sale de Revisión manual, el sistema debe dejar de mostrar su motivo.

### Revisión de pagos por el usuario
- RF-141: La interfaz de revisión debe listar las facturas en estado Pago recibido o Revisión manual, con el email recibido, sus adjuntos, la clasificación del LLM de cada adjunto, el CUIT y el monto extraídos de cada comprobante, y el motivo de la revisión manual cuando corresponda.
- RF-142: La interfaz de revisión debe listar los avisos Pendientes, con su remitente, asunto, fecha y adjuntos.
- RF-143: El sistema debe permitir a un Admin o Editor pasar, desde la interfaz de revisión, una factura en estado Pago recibido a Pagada.
- RF-144: El sistema debe permitir a un Admin o Editor devolver, desde la interfaz de revisión, una factura en estado Pago recibido a Pendiente de pago.
- RF-145: El sistema debe permitir a un Admin o Editor pasar, desde la interfaz de revisión, una factura en estado Revisión manual a Pagada.
- RF-146: El sistema debe permitir a un Admin o Editor devolver, desde la interfaz de revisión, una factura en estado Revisión manual a Pendiente de pago.
- RF-147: El sistema debe permitir a un Admin o Editor pasar, desde el listado de facturas, una factura en estado Pendiente de pago a Pagada.
- RF-148: El sistema debe permitir a un Admin o Editor marcar un aviso como Revisado desde la interfaz de revisión.

### Recordatorios y dashboard
- RF-149: El agente debe enviar el último día de cada mes, a la hora de recordatorios (11:00 por defecto), un email recordatorio a cada cliente Activo con deuda vigente, tenga o no productos asignados, salvo a los clientes en revisión.
- RF-150: El email recordatorio, automático o manual, debe detallar cada factura adeudada del cliente (número, período, importe y vencimiento) y el total a pagar, que es la suma de todas ellas.
- RF-151: El email recordatorio, automático o manual, debe pedirle al cliente que responda el email adjuntando el comprobante de pago.
- RF-152: El sistema debe permitir a un Admin configurar la hora de recordatorios con un valor entre 00:00 y 23:39.
- RF-153: El sistema debe mostrar un dashboard con el listado de los clientes con deuda vigente, con su razón social, su deuda vigente total, la cantidad de facturas adeudadas y si está en revisión.
- RF-154: El sistema debe permitir enviar manualmente, desde el dashboard, un email recordatorio a un cliente con deuda vigente.
- RF-155: El sistema no debe enviar el recordatorio automático de fin de mes a un cliente sin deuda vigente.
- RF-156: El sistema no debe permitir enviar el recordatorio manual desde el dashboard a un cliente sin deuda vigente.
- RF-157: El sistema no debe permitir enviar el recordatorio manual desde el dashboard a un cliente en revisión.

### Listados, historial y reportes
- RF-158: El sistema debe mostrar el listado de clientes, Activos e Inactivos, con su razón social, CUIT, email de facturación, condición frente al IVA, estado y deuda vigente total.
- RF-159: El sistema debe mostrar el listado de productos, Activos e Inactivos, con su nombre, precio, moneda y estado.
- RF-160: El sistema debe mostrar el listado de facturas con su punto de venta y número, la razón social del cliente, el período, el total en pesos, la fecha de vencimiento del pago y el estado.
- RF-161: El sistema debe mostrar a un Admin el listado de usuarios, Activos e Inactivos, con su nombre, email, perfil y estado.
- RF-162: El sistema debe permitir a un usuario de cualquier perfil descargar, desde el listado de facturas, el PDF de cualquier factura emitida.
- RF-163: El sistema debe mostrar el historial de cada cliente, con sus eventos en orden cronológico.
- RF-164: El sistema debe mostrar un reporte de facturación por período que indique, para cada período, la cantidad de facturas emitidas y su total en pesos.
- RF-165: El sistema debe mostrar un reporte de cobranza por período que indique, para cada período, el total facturado y la parte de ese total en estado Pagada, en Pago recibido y adeudada (Pendiente de pago y Revisión manual).
- RF-166: El sistema debe mostrar un reporte de deuda por cliente que liste cada cliente con deuda vigente, su deuda vigente total y el detalle de sus facturas adeudadas (número, período, importe, vencimiento y estado).
- RF-167: El sistema debe permitir a un usuario de cualquier perfil descargar cada reporte como archivo CSV.
- RF-168: El sistema debe permitir filtrar el listado de facturas por estado, por cliente y por período.
- RF-169: El sistema debe permitir filtrar el listado de clientes por estado y buscar un cliente por su razón social o su CUIT.
- RF-170: El sistema debe permitir filtrar los reportes de facturación y de cobranza por un rango de períodos.

### Errores de procesos automáticos
- RF-171: Si falla la generación de una factura (en ARCA, o por falta de cotización según RF-68), el envío del email de una factura o el envío de un recordatorio automático, el agente debe reintentar la operación hasta la cantidad de reintentos configurada (3 por defecto), esperando entre intentos la espera configurada (5 minutos por defecto).
- RF-172: El sistema debe permitir a un Admin configurar la cantidad de reintentos con un valor entre 0 y 10.
- RF-173: El sistema debe permitir a un Admin configurar la espera entre reintentos con un valor entre 1 y 60 minutos.
- RF-174: Si la operación sigue fallando después del último reintento, el agente debe registrar un error de proceso Pendiente con la operación, la cantidad de intentos, el último mensaje de error y, cuando corresponda, el cliente y el período.
- RF-175: La interfaz de revisión debe listar los errores de proceso Pendientes con sus datos.
- RF-176: El sistema debe permitir a un Admin o Editor reintentar manualmente, desde la interfaz de revisión y con un único intento, la operación de un error de proceso Pendiente de generación de factura, de envío de factura o de envío de recordatorio.
- RF-177: En el reintento manual de un error de generación de factura, el sistema debe generar la factura y, si se genera, enviarla por email según RF-84.
- RF-178: En el reintento manual de un error de envío de factura o de recordatorio, el sistema debe reenviar solo el email que falló, sin generar de nuevo la factura.
- RF-179: Si el reintento manual tiene éxito, el sistema debe pasar el error de proceso a Resuelto.
- RF-180: El sistema debe permitir a un Admin o Editor marcar un error de proceso Pendiente como Resuelto sin reintentarlo.
- RF-181: Mientras haya al menos un error de proceso Pendiente, el sistema debe mostrar el banner de errores con la cantidad de errores Pendientes.
- RF-182: Si falla una acción iniciada por un usuario (por ejemplo, el envío de un recordatorio manual), el sistema debe mostrarle un mensaje de error.
- RF-183: El sistema no debe reintentar automáticamente ni registrar un error de proceso nuevo cuando falla una acción iniciada por un usuario.

### Modo mock
- RF-184: El sistema debe funcionar en modo mock solo cuando la variable de entorno MOCK_MODE vale "true".
- RF-185: En modo mock, el agente no debe conectarse a ARCA (ni a WSAA ni a WSFEv1).
- RF-186: En modo mock, el agente debe autorizar cada factura con el número siguiente al de la última factura emitida en modo mock en ese punto de venta (empezando por 1) y con un CAE ficticio de 14 dígitos que vence 10 días después de la fecha de emisión.
- RF-187: En modo mock, el agente no debe llamar a la API de Claude.
- RF-188: En modo mock, el agente debe clasificar cada adjunto según su nombre de archivo, con las reglas RF-189 a RF-193, sin distinguir mayúsculas de minúsculas.
- RF-189: En modo mock, el agente debe clasificar como "si" un adjunto llamado `pago_<CUIT>_<monto>.<extensión>`, con ese CUIT y ese monto (con punto decimal, por ejemplo `pago_30711111111_15000.50.pdf`).
- RF-190: En modo mock, cuando el nombre de un adjunto "si" tiene una `x` en lugar del CUIT o del monto, el agente debe considerar que ese dato no se pudo extraer.
- RF-191: En modo mock, el agente debe clasificar como "dudoso" un adjunto cuyo nombre empieza con `dudoso`.
- RF-192: En modo mock, el agente debe marcar como erróneo el procesamiento de un adjunto cuyo nombre empieza con `error`.
- RF-193: En modo mock, el agente debe clasificar como "no" un adjunto cuyo nombre no cumple ninguna de las reglas RF-189 a RF-192.
- RF-194: En modo mock, el sistema no debe conectarse a Gmail (ni por SMTP ni por IMAP).
- RF-195: En modo mock, el sistema debe usar aldebaran-mock@gmail.com como dirección de la casilla del sistema.
- RF-196: En modo mock, el sistema debe guardar en la casilla simulada cada email que envía (facturas y recordatorios), con su destinatario, asunto, cuerpo, adjuntos y fecha de envío.
- RF-197: En modo mock, el sistema debe mostrar a un Admin todos los emails de la casilla simulada, enviados y recibidos.
- RF-198: En modo mock, el sistema debe mostrar a un Editor o a un usuario Consulta solo los emails de la casilla simulada recibidos desde el email de facturación de un cliente.
- RF-199: En modo mock, el sistema no debe permitir solicitar la recuperación de contraseña.
- RF-200: En modo mock, el sistema debe permitir a un Admin o Editor cargar en la casilla simulada un email recibido, con su remitente, asunto, cuerpo y adjuntos.
- RF-201: El sistema debe registrar como fecha de recepción de cada email cargado en la casilla simulada el momento en que se carga.
- RF-202: El sistema debe asignar un Message-ID único a cada email recibido que se carga en la casilla simulada.
- RF-203: En modo mock, el agente debe procesar los emails recibidos de la casilla simulada en la siguiente revisión de la casilla, con las mismas reglas que los emails recibidos en la casilla del sistema.
- RF-204: Fuera del modo mock, el sistema no debe permitir acceder a la casilla simulada ni cargar emails en ella.
- RF-205: En modo mock, el sistema debe arrancar y funcionar con MOCK_MODE como única variable de entorno definida.
- RF-206: En modo mock, si ARCA_CUIT no está definida, el agente debe usar 20111111112 como CUIT del emisor.
- RF-207: En modo mock, si SCHEDULER_ENABLED no está definida, el agente debe ejecutar los procesos automáticos (facturación, recordatorios y revisión de la casilla).
- RF-208: En modo mock, el sistema no debe mostrar el banner de certificado.
- RF-209: En modo mock, el sistema debe mostrar en el header de todas las pantallas el indicador "Modo mock: ARCA, LLM y email simulados".
- RF-210: En modo mock, el agente debe indicar en el PDF de cada factura y en cada email que envía que fue generado en modo mock y es simulado.
- RF-211: En modo mock, el sistema debe usar siempre la base de datos data/aldebaran-mock.db, sin tener en cuenta DATABASE_PATH.
- RF-212: Fuera del modo mock, el sistema no debe leer ni escribir la base de datos data/aldebaran-mock.db.
- RF-213: Fuera del modo mock, si DATABASE_PATH apunta a data/aldebaran-mock.db, el sistema no debe arrancar y debe informar el error.

## Requerimientos No Funcionales
- RNF-01: El p95 del tiempo de procesamiento de un email de respuesta, medido desde que se detecta hasta que queda registrado el resultado (lectura, clasificación por LLM, validación y eventuales reintentos de RNF-02), debe ser menor a 60 segundos.
- RNF-02: Ante una falla de una llamada al LLM, el agente debe reintentarla hasta 3 veces, esperando 2 s, 4 s y 8 s antes de cada reintento; si el cuarto intento también falla, marca como erróneo el procesamiento de ese adjunto (ver RF-123). Se considera falla: (a) que la llamada no responda dentro de 10 s; (b) un error de red o una respuesta HTTP 429 o 5xx; (c) una respuesta que no se puede interpretar o cuya clasificación no es "si", "no" ni "dudoso". Las respuestas HTTP 400, 401 y 403 no se reintentan y marcan el procesamiento del adjunto como erróneo de inmediato; tampoco se reintentan las demás respuestas 4xx (por ejemplo, 404 o 413), salvo 408 y 429, que se reintentan. Con estos valores, el peor caso de un adjunto (4 intentos × 10 s + 14 s de espera = 54 s) entra en el límite de RNF-01.
- RNF-03: El proceso de facturación mensual, incluidos la generación de las facturas en ARCA y el envío de los emails de RF-84, no debe durar más de 20 minutos desde su inicio, sin contar los reintentos de RF-171.
- RNF-04: El proceso de recordatorios de fin de mes, incluido el envío de los emails de RF-149, no debe durar más de 20 minutos desde su inicio, sin contar los reintentos de RF-171.
- RNF-05: El proceso de facturación mensual debe cumplir RNF-03 con al menos 50 clientes Activos, cada uno con hasta 2 productos asignados, y un catálogo de hasta 10 productos. Estos valores son el volumen de referencia, no límites del sistema.
- RNF-06: El proceso de recordatorios de fin de mes debe cumplir RNF-04 con al menos 50 clientes Activos con deuda vigente. Este valor es el volumen de referencia, no un límite del sistema.
- RNF-07: Una llamada a un servicio externo se considera fallida si no responde dentro de: 30 s para ARCA (WSAA y WSFEv1), 30 s para el servidor de email (SMTP e IMAP) y 10 s para dolarhoy.com.
- RNF-08: La API key del modelo no debe estar en el código; se lee de la variable de entorno ANTHROPIC_API_KEY.
- RNF-09: Las contraseñas deben almacenarse con hash seguro (bcrypt con costo ≥ 12, o argon2id), nunca en texto plano.
- RNF-10: La sesión de un usuario debe expirar tras 24 h de inactividad.
- RNF-11: Las credenciales de la casilla de email (usuario/contraseña o token de acceso) y las credenciales/certificado del ambiente de homologación de ARCA deben leerse de variables de entorno; nunca deben quedar en el código ni en el repositorio.
- RNF-12: Todas las fechas y horarios del sistema (día 15, hora de facturación, último día del mes, hora de recordatorios, vencimiento de sesión y de tokens de recuperación) se rigen por la zona horaria America/Argentina/Buenos_Aires.
- RNF-13: Todos los montos (precios de productos, ítems y totales de factura, montos extraídos de comprobantes y cotizaciones) se registran con precisión de centavos, y la coincidencia de monto (RF-134 a RF-137) se evalúa al centavo exacto, sin redondeos. La única operación que redondea es la conversión de dólares a pesos (RF-64). Si el monto extraído de algún comprobante del email es igual o menor a cero, o tiene fracción de centavo, el email no tiene ninguna coincidencia de monto.
- RNF-14: La clasificación del LLM (RF-119), medida sobre el set de prueba de AC-109 a AC-111 (al menos 20 adjuntos por clase), debe acertar en al menos el 95 % de los adjuntos de cada clase ("si", "no" y "dudoso"), y ningún comprobante legible debe clasificarse como "no".

## Criterios de Aceptación

### Usuarios y perfiles
- AC-01 (RF-02): Dado un usuario Activo, cuando inicia sesión con su email y su contraseña, entonces accede al sistema; y cuando lo intenta con una contraseña incorrecta, el sistema rechaza el inicio de sesión.
- AC-02 (RF-03): Dado un usuario autenticado, cuando cierra su sesión, entonces el sistema lo lleva al inicio de sesión y rechaza cualquier solicitud posterior hecha con esa sesión.
- AC-03 (RF-04, RF-22): Dado el sistema sin ningún usuario, cuando se ingresa a la aplicación, entonces se muestra la pantalla de registro del primer Admin; al registrar un nombre, un email y una contraseña de 7 caracteres, el sistema rechaza el registro; y con una contraseña de 8 caracteres, el usuario queda Activo con perfil Admin y puede iniciar sesión.
- AC-04 (RF-06): Dado un Admin autenticado, cuando abre el listado de usuarios, la configuración, los listados de clientes, productos y facturas, el dashboard, la interfaz de revisión, los reportes y el historial de un cliente, entonces ve los datos de cada uno.
- AC-05 (RF-07): Dado un Admin autenticado, cuando abre el listado o los datos de un usuario, desde la pantalla o por endpoint, entonces la respuesta no incluye el hash de la contraseña.
- AC-06 (RF-08): Dado un Admin autenticado, cuando modifica el intervalo de revisión de la casilla, entonces el valor nuevo queda guardado. (Las demás acciones del Admin se verifican en los AC de cada RF.)
- AC-07 (RF-09): Dado un Editor autenticado, cuando abre los listados de clientes, productos y facturas, el dashboard, la interfaz de revisión, los reportes y el historial de un cliente, entonces ve los datos de cada uno.
- AC-08 (RF-10): Dado un Editor autenticado, cuando da de alta un cliente, entonces el cliente queda registrado.
- AC-09 (RF-10): Dado un Editor autenticado, cuando asigna un producto Activo a un cliente Activo, entonces el producto queda asignado al cliente.
- AC-10 (RF-10): Dado un Editor autenticado, cuando pasa una factura de Pago recibido a Pagada, entonces la factura queda en estado Pagada.
- AC-11 (RF-11): Dado un usuario Consulta autenticado, cuando abre los listados de clientes, productos y facturas, el dashboard, la interfaz de revisión, los reportes y el historial de un cliente, entonces ve los datos de cada uno.
- AC-12 (RF-09, RF-11): Dado un recordatorio manual registrado en el historial de un cliente, cuando un Editor o un usuario Consulta abre ese historial, entonces ve el nombre del usuario que envió el recordatorio.
- AC-13 (RF-12, RF-154): Dado un usuario de cualquier perfil en el dashboard, cuando selecciona "enviar recordatorio" sobre un cliente Activo con deuda vigente que no está en revisión, entonces se envía el email y queda registrada en el historial del cliente la acción junto con el usuario que la ejecutó.
- AC-14 (RF-14): Dado un Admin autenticado, cuando da de alta un usuario con nombre, email, perfil Admin, Editor o Consulta y contraseña, entonces el usuario queda registrado como Activo con ese perfil y puede iniciar sesión con ese email y esa contraseña.
- AC-15 (RF-15): Dado un usuario registrado con el email ana@empresa.com, cuando un Admin intenta dar de alta otro usuario con el email Ana@Empresa.com, o modificar otro usuario para que tenga ese email, entonces el sistema rechaza la acción y nada cambia.
- AC-16 (RF-16): Dado un usuario registrado, cuando un Admin modifica su nombre y su email, entonces los datos nuevos quedan guardados, se muestran en el listado de usuarios y el usuario inicia sesión con el email nuevo.
- AC-17 (RF-17): Dado un usuario con perfil Editor, cuando un Admin le cambia el perfil a Consulta, entonces a partir de su siguiente acción el usuario solo puede realizar las acciones permitidas al perfil Consulta.
- AC-18 (RF-18, RF-02): Dado un usuario Activo, cuando un Admin lo da de baja, entonces el usuario pasa a Inactivo y ya no puede iniciar sesión.
- AC-19 (RF-19): Dado un usuario Inactivo, cuando un Admin lo reactiva, entonces el usuario pasa a Activo y puede iniciar sesión.
- AC-20 (RF-20): Dado un único usuario Admin Activo, cuando un Admin intenta darlo de baja o cambiarle el perfil a Editor, entonces el sistema rechaza la acción y el usuario sigue Activo con perfil Admin; y dados dos usuarios Admin Activos, cuando un Admin da de baja a uno de ellos, la baja se realiza.

### Contraseñas
- AC-21 (RF-21): Dado un usuario autenticado de cualquier perfil, cuando cambia su contraseña desde su perfil ingresando la contraseña actual correcta y una nueva, entonces puede iniciar sesión con la nueva y no con la anterior.
- AC-22 (RF-21): Dado un usuario autenticado, cuando intenta cambiar su contraseña ingresando una contraseña actual incorrecta, entonces el sistema rechaza el cambio y la contraseña no cambia.
- AC-23 (RF-22): Dado un usuario autenticado, cuando intenta cambiar su contraseña desde su perfil por una de 7 caracteres, entonces el sistema rechaza el cambio y la contraseña no cambia; y cuando la cambia por una de 8 caracteres, el cambio se guarda.
- AC-24 (RF-22): Dado un Admin autenticado, cuando intenta dar de alta un usuario con una contraseña de 7 caracteres, entonces el sistema rechaza el alta.
- AC-25 (RF-22): Dada la pantalla de cambio de contraseña abierta con un token válido, cuando el usuario confirma una nueva contraseña de 7 caracteres, entonces el sistema rechaza el cambio y la contraseña no cambia.
- AC-26 (RF-23, RF-24): Dado un usuario Activo, cuando solicita la recuperación de contraseña con su email desde la pantalla de inicio de sesión, entonces recibe un email con una URL que contiene un token de recuperación.
- AC-27 (RF-25): Dado un email que no corresponde a ningún usuario Activo, cuando se solicita la recuperación de contraseña con ese email, entonces se muestra el mismo mensaje de confirmación que para un usuario Activo y no se envía ningún email.
- AC-28 (RF-26, RF-29, RF-32): Dado un token de recuperación sin usar enviado hace 9 minutos, cuando el usuario ingresa a la URL, entonces el sistema muestra la pantalla de cambio de contraseña.
- AC-29 (RF-26, RF-29, RF-30, RF-31): Dado un token de recuperación enviado hace 11 minutos, cuando el usuario ingresa a la URL, entonces el sistema muestra un mensaje de error y a los 5 segundos (±1 s) redirige al inicio de sesión.
- AC-30 (RF-27, RF-30, RF-31): Dado un token de recuperación que ya se usó para cambiar la contraseña, cuando el usuario vuelve a ingresar a la URL, entonces el sistema muestra un mensaje de error y a los 5 segundos (±1 s) redirige al inicio de sesión.
- AC-31 (RF-28, RF-30, RF-31): Dado un usuario que solicitó dos veces la recuperación de contraseña, cuando ingresa a la URL del primer email, entonces el sistema muestra un mensaje de error y a los 5 segundos (±1 s) redirige al inicio de sesión; y la URL del segundo email muestra la pantalla de cambio de contraseña.
- AC-32 (RF-29, RF-30, RF-31): Dada la pantalla de cambio de contraseña abierta con un token que vence antes de que el usuario confirme, cuando el usuario confirma la nueva contraseña, entonces el sistema muestra un mensaje de error, la contraseña no cambia y a los 5 segundos (±1 s) redirige al inicio de sesión.
- AC-33 (RF-33): Dada la pantalla de cambio de contraseña abierta con un token válido, cuando el usuario confirma una nueva contraseña, entonces la contraseña queda cambiada, el sistema redirige al inicio de sesión y el usuario puede iniciar sesión con la nueva contraseña.

### Clientes
- AC-34 (RF-34): Dado un Admin o Editor autenticado, cuando completa el alta de un cliente con sus datos obligatorios (razón social, CUIT, email de facturación, condición frente al IVA), entonces el cliente queda visible en el listado con estado Activo y disponible para asignarle productos; y cuando intenta darlo de alta sin razón social, sin CUIT o sin email de facturación, el sistema rechaza el alta.
- AC-35 (RF-35): Dado un cliente Activo, cuando un Admin o Editor modifica su email de facturación, entonces los emails siguientes a ese cliente se envían a la nueva dirección y los emails recibidos desde la dirección anterior dejan de reconocerse como del cliente.
- AC-36 (RF-35): Dado un cliente Activo con facturas ya emitidas, cuando un Admin o Editor modifica su razón social, entonces la siguiente factura muestra la razón social nueva y las facturas ya emitidas no cambian.
- AC-37 (RF-35): Dado un cliente Activo con deuda vigente que no está en revisión, cuando un Admin o Editor modifica su CUIT y después llega un comprobante clasificado como "si" con el CUIT anterior, entonces sus facturas adeudadas pasan a Revisión manual con el motivo "CUIT no coincide".
- AC-38 (RF-36): Dado un cliente Activo, cuando un Admin o Editor lo da de baja, entonces el cliente pasa a estado Inactivo y sigue apareciendo en el listado con ese estado.
- AC-39 (RF-37): Dado un cliente Inactivo con al menos un producto Activo asignado, cuando un Admin o Editor lo reactiva, entonces el cliente pasa a estado Activo y en el siguiente proceso de facturación del día 15 se le genera una única factura, solo por el período corriente.
- AC-40 (RF-34, RF-38): Dado un Admin o Editor autenticado, cuando intenta dar de alta un cliente sin condición frente al IVA, o con una condición que no está en la lista de RF-38, entonces el sistema rechaza el alta.
- AC-41 (RF-39): Dado un Admin o Editor autenticado, cuando intenta dar de alta un cliente con el CUIT 30711111118 (dígito verificador incorrecto; el correcto es 1), o modificar un cliente para que tenga ese CUIT, entonces el sistema rechaza la acción y nada cambia; y con el CUIT 30711111111 la acción se realiza.
- AC-42 (RF-40, RF-41): Dado un cliente registrado con el CUIT 30711111118 y el email de facturación pagos@losandes.com, cuando un Admin o Editor intenta dar de alta otro cliente con ese CUIT, o con el email Pagos@LosAndes.com, o modificar otro cliente para que tenga alguno de esos datos, entonces el sistema rechaza la acción y nada cambia.

### Productos
- AC-43 (RF-42, RF-43): Dado un Admin o Editor autenticado, cuando da de alta un producto indicando nombre, precio de la cuota mensual y moneda (pesos o dólares), entonces el producto queda registrado como Activo con ese precio y esa moneda, y disponible para asignarlo a uno o más clientes.
- AC-44 (RF-44): Dado un Admin o Editor autenticado, cuando intenta dar de alta un producto con precio 0 o -100, o modificar el precio de un producto a 0, entonces el sistema rechaza la acción y nada cambia; y con un precio de 0,01 la acción se realiza.
- AC-45 (RF-45): Dado un producto asignado a un cliente con facturas ya emitidas, cuando un Admin o Editor modifica su nombre, entonces la siguiente factura muestra el nombre nuevo y las facturas ya emitidas no cambian.
- AC-46 (RF-46): Dado un producto asignado a un cliente con facturas ya emitidas, cuando un Admin o Editor modifica su precio, entonces la siguiente factura usa el precio nuevo y las facturas ya emitidas no cambian.
- AC-47 (RF-47): Dado un producto Activo, cuando un Admin o Editor lo desactiva, entonces el producto pasa a Inactivo, sigue apareciendo en el listado con ese estado, deja de estar disponible para nuevas asignaciones y no se incluye en las facturas que se generen después.
- AC-48 (RF-48): Dado un producto Inactivo asignado a un cliente Activo, cuando un Admin o Editor lo reactiva, entonces el producto pasa a Activo, vuelve a estar disponible para nuevas asignaciones y se incluye en la siguiente factura de ese cliente.
- AC-49 (RF-49): Dado un cliente Activo y uno o más productos Activos, cuando un Admin o Editor le asigna esos productos, entonces el cliente queda vinculado a ellos y el monto en pesos de su próxima factura es la suma de las cuotas de esos productos, con las cuotas en dólares convertidas según RF-63.
- AC-50 (RF-50): Dado un cliente Activo con dos productos Activos asignados y facturas ya emitidas, cuando un Admin o Editor le desasigna uno de ellos, entonces la siguiente factura del cliente incluye solo el producto que sigue asignado y las facturas ya emitidas no cambian.

### Facturación
- AC-51 (RF-51): Dado que es el día 15 del mes y la hora de facturación configurada, cuando el agente ejecuta el proceso de facturación, entonces se genera contra el ambiente de homologación de ARCA una factura por cada cliente Activo con al menos un producto Activo asignado, con el detalle de cada cuota mensual, y la factura queda registrada en estado Pendiente de pago.
- AC-52 (RF-51): Dada la hora de facturación por defecto, cuando llega el día 15, entonces el proceso de facturación se inicia a las 11:00 hora de Argentina, con una tolerancia de ±1 minuto.
- AC-53 (RF-52): Dado el sistema detenido el 15/10/2026 a la hora de facturación, cuando vuelve a funcionar el 17/10/2026, entonces el proceso de facturación del período octubre de 2026 se inicia dentro del minuto siguiente; y dado el sistema detenido entre el 15/10/2026 y el 01/11/2026, cuando vuelve a funcionar en noviembre, entonces no se factura el período octubre de 2026.
- AC-54 (RF-53): Dado un proceso de facturación del período corriente interrumpido después de facturar a algunos clientes, cuando el sistema vuelve a funcionar, entonces el proceso se retoma, factura a los clientes que faltaban y no genera una segunda factura para los que ya tenían.
- AC-55 (RF-54, RF-55): Dado el 10/10/2026 y el período octubre de 2026 sin cancelar, cuando un Admin cancela la facturación de ese período, entonces el 15/10/2026 a la hora de facturación no se genera ninguna factura del período octubre de 2026; y dado el sistema detenido el 15/10/2026 con octubre de 2026 cancelado, cuando vuelve a funcionar el 17/10/2026, tampoco se genera ninguna.
- AC-56 (RF-54): Dado el proceso de facturación del período octubre de 2026 ya iniciado, cuando un Admin intenta cancelar la facturación de ese período, entonces el sistema rechaza la acción.
- AC-57 (RF-56, RF-57): Dado el período octubre de 2026 cancelado, cuando un Admin reactiva su facturación el 20/10/2026, entonces el proceso de facturación de octubre de 2026 se inicia dentro del minuto siguiente; y dado octubre de 2026 cancelado, cuando un Admin intenta reactivarlo el 01/11/2026, entonces el sistema rechaza la acción.
- AC-58 (RF-58, RF-59, RF-79): Dado el 05/10/2026 y el período octubre de 2026 sin facturar ni cancelar, cuando un Admin presiona "Facturar ahora", entonces el proceso de facturación de octubre de 2026 se inicia dentro del minuto siguiente y genera las facturas con fecha de emisión 05/10/2026; y el 15/10/2026 a la hora de facturación el agente no ejecuta el proceso de facturación, por lo que un cliente dado de alta el 10/10/2026 no recibe factura del período octubre de 2026.
- AC-59 (RF-60): Dado el período del mes en curso cancelado, cuando un Admin abre la pantalla de facturación, entonces el botón "Facturar ahora" aparece deshabilitado con la indicación de que la facturación del mes está cancelada; y una solicitud directa al endpoint de facturación manual es rechazada sin generar ninguna factura.
- AC-60 (RF-61): Dado el proceso de facturación del período del mes en curso en ejecución, cuando un Admin abre la pantalla de facturación, entonces el botón "Facturar ahora" aparece deshabilitado con la indicación "facturación en curso"; y una vez terminado el proceso, aparece deshabilitado con la indicación "facturación del mes ya realizada"; en ambos casos, una solicitud directa al endpoint de facturación manual es rechazada sin generar ninguna factura.
- AC-61 (RF-62): Dado un Admin autenticado, cuando cambia la hora de facturación a 14:00, entonces el siguiente proceso de facturación del día 15 se inicia a las 14:00 hora de Argentina, con una tolerancia de ±1 minuto.
- AC-62 (RF-62): Dado un Admin autenticado, cuando intenta configurar la hora de facturación en 23:40, entonces el sistema rechaza el valor y mantiene la hora anterior.
- AC-63 (RF-63): Dado un cliente con un producto asignado cuyo precio está fijado en dólares y dolarhoy.com respondiendo con una cotización del dólar blue venta de $1.500, cuando el agente genera la factura mensual, entonces convierte ese monto a pesos con la cotización de $1.500, y esa cotización y su fuente quedan registradas en la factura.
- AC-64 (RF-64): Dado un producto con precio de USD 0,01 y una cotización de $1.555,50, cuando el agente lo factura, entonces el ítem se factura por $15,56 ($15,555 redondeado al centavo más cercano).
- AC-65 (RF-67, RF-65, RF-66): Dadas tres cotizaciones registradas, leídas el 15/08 ($1.490), el 15/09 ($1.500) y el 20/09 ($1.520), y dolarhoy.com sin responder dentro de 10 s (RNF-07), cuando el agente factura un producto con precio en dólares, entonces usa la cotización del 20/09 ($1.520); y cuando dolarhoy.com responde, la cotización leída queda registrada con su valor, la fuente y la fecha de lectura.
- AC-66 (RF-67, RF-69): Dada una cotización registrada anteriormente y dolarhoy.com sin responder dentro de 10 s (RNF-07), cuando el agente factura un producto con precio en dólares, entonces usa esa última cotización, la registra en la factura con su fecha, y el dashboard muestra el banner de cotización con la cotización usada y su fecha.
- AC-67 (RF-68, RF-174): Dados un cliente con al menos un producto con precio en dólares, dolarhoy.com sin responder dentro de 10 s (RNF-07), ninguna cotización registrada anteriormente y la cantidad de reintentos configurada en 0, cuando el agente ejecuta el proceso de facturación, entonces no se genera la factura de ese cliente, no se le envía email de factura y se registra un error de proceso Pendiente de generación de factura para ese cliente.
- AC-68 (RF-68): Dados un cliente con todos sus productos con precio en pesos, dolarhoy.com sin responder dentro de 10 s (RNF-07) y ninguna cotización registrada anteriormente, cuando el agente ejecuta el proceso de facturación, entonces la factura de ese cliente se genera, queda en Pendiente de pago y se le envía su email de factura.
- AC-69 (RF-70): Dado el banner de cotización visible, cuando un Admin o Editor confirma la cotización, entonces el banner deja de mostrarse y queda registrado qué usuario la confirmó.
- AC-70 (RF-71, RF-72): Dado el punto de venta configurado en 3, cuando el agente genera una factura, entonces la solicitud a WSFEv1 de homologación usa el tipo de comprobante Factura C (código 11) y el punto de venta 3, y ambos quedan registrados en la factura.
- AC-71 (RF-73): Dado un Admin autenticado, cuando intenta configurar el punto de venta en 0 o en 100000, entonces el sistema rechaza el valor y mantiene el punto de venta anterior; y cuando lo configura en 5, la siguiente factura se emite en el punto de venta 5.
- AC-72 (RF-74): Dado un cliente al que ya se le generó la factura del período corriente, cuando el proceso de facturación se vuelve a ejecutar en el mismo mes, entonces no se genera otra factura para ese cliente ni se le envía otro email de factura.
- AC-73 (RF-75, RF-76): Dado un cliente facturable y ARCA homologación que autoriza su factura pero cuya respuesta no llega dentro de 30 s (RNF-07), cuando el agente reintenta la generación, entonces registra la factura con el número y el CAE que ARCA otorgó en el primer intento, no solicita otro comprobante y en ARCA queda un único comprobante para ese cliente y período.
- AC-74 (RF-77, RF-78): Dado un cliente con la condición Responsable Monotributo y una factura ya emitida, cuando un Admin o Editor cambia su condición a IVA Responsable Inscripto, entonces la siguiente factura se informa a ARCA con la condición 1 y queda registrada con esa condición, y la factura ya emitida conserva la condición 6.
- AC-75 (RF-79, RF-80, RF-81): Dado el proceso de facturación del 15/10/2026, cuando el agente genera la factura de un cliente, entonces la factura tiene fecha de emisión 15/10/2026, período de servicio del 01/10/2026 al 31/10/2026 y vencimiento del pago el 31/10/2026.
- AC-76 (RF-79, RF-80, RF-81): Dado un error de proceso Pendiente de generación de la factura del período octubre de 2026, cuando un Admin o Editor lo reintenta manualmente el 03/11/2026 y la factura se genera, entonces la factura tiene fecha de emisión 03/11/2026, período de servicio del 01/10/2026 al 31/10/2026 y vencimiento del pago el 03/11/2026.
- AC-77 (RF-82, RF-83): Dado un cliente Activo con un producto Activo asignado y sin condición frente al IVA, y la cantidad de reintentos configurada en 0, cuando el agente ejecuta el proceso de facturación, entonces no se genera la factura de ese cliente, no se llama a ARCA para ese cliente y se registra un error de proceso Pendiente de generación de factura con el mensaje "el cliente no tiene cargada la condición frente al IVA".
- AC-78 (RF-84): Dado que el proceso de facturación del día 15 generó una factura para un cliente, cuando la factura queda registrada, entonces se envía la factura por email al email de facturación del cliente informando que tiene una deuda pendiente, y el envío (fecha, hora y destinatario) queda registrado en el historial del cliente.
- AC-79 (RF-85, RF-87): Dados dos clientes facturables y ARCA homologación que falla en el primer intento de generar la factura del primero, cuando el agente ejecuta el proceso de facturación, entonces el email de la factura del segundo cliente se envía sin esperar el reintento del primero, y el del primero se envía apenas se genera su factura.
- AC-80 (RF-86): Dado un cliente cuya factura se generó y un servidor de email que rechaza el primer envío y acepta el segundo, cuando el agente reintenta el envío, entonces se envía el email de esa factura y en ARCA queda un único comprobante para ese cliente y período.
- AC-81 (RF-88, RF-89): Dado un cliente con una factura de septiembre de $15.000 en Revisión manual, cuando el proceso de facturación genera su factura de octubre de $201.600, entonces el email informa esa factura con su número, período, importe y vencimiento, una deuda pendiente de $216.600 que incluye facturas anteriores, y le pide responder adjuntando el comprobante de pago.
- AC-82 (RF-90): Dado el sistema facturando en homologación de ARCA, cuando se envía el email de una factura, entonces tanto el PDF como el cuerpo del email indican que el comprobante fue emitido en homologación y no tiene validez fiscal.
- AC-83 (RF-91, RF-92): Dado un Admin autenticado, cuando configura la razón social, el domicilio comercial, la condición frente al IVA, el número de ingresos brutos y la fecha de inicio de actividades de la empresa emisora, entonces los datos quedan guardados y el PDF de la siguiente factura los incluye junto con el CUIT del emisor.
- AC-84 (RF-84, RF-93): Dado que el proceso de facturación generó una factura para un cliente, cuando se envía el email de la factura, entonces el email lleva un archivo PDF adjunto con la razón social, el CUIT y la condición frente al IVA del cliente, Factura C, el punto de venta, el número, la fecha de emisión, el período con su período de servicio, el vencimiento del pago, el detalle de cada cuota, el total en pesos, el CAE y su vencimiento; y, si algún ítem estaba en dólares, la cotización usada.
- AC-85 (RF-94): Dado un cliente Activo sin ningún producto asignado, cuando se ejecuta el proceso de facturación del día 15, entonces no se genera factura ni se envía email de factura para ese cliente.
- AC-86 (RF-94): Dado un cliente Activo cuyo único producto asignado está Inactivo, cuando se ejecuta el proceso de facturación del día 15, entonces no se genera factura para ese cliente.
- AC-87 (RF-95): Dado un cliente Inactivo con productos asignados, cuando se ejecuta el proceso de facturación del día 15, entonces no se genera factura para ese cliente.
- AC-88 (RF-96): Dado un cliente Inactivo con facturas adeudadas, cuando se ejecuta el proceso de recordatorios de fin de mes, entonces no se envía ningún email a ese cliente.
- AC-89 (RF-96): Dado un cliente Inactivo con facturas adeudadas, cuando un usuario intenta enviarle el recordatorio manual desde el dashboard, entonces el sistema bloquea la acción, no envía ningún email y muestra un mensaje indicando que el cliente está Inactivo.
- AC-90 (RF-97): Dado un certificado de ARCA cuya fecha de vencimiento ya pasó, o un archivo de certificado que no se puede leer, cuando un usuario autenticado abre el dashboard, entonces ve el banner de certificado indicando que no se puede realizar la facturación; y con un certificado legible al que le faltan más de 30 días para vencer, el banner no se muestra.
- AC-91 (RF-98): Dado un certificado de ARCA vigente que vence dentro de 30 días, cuando un usuario autenticado abre el dashboard, entonces ve el banner de certificado con la fecha de vencimiento y el aviso de renovarlo; y si vence dentro de 31 días, el banner no se muestra.

### Control de pagos
- AC-92 (RF-99): Dado el intervalo de revisión por defecto, cuando transcurren 15 minutos desde el inicio de la última revisión, entonces el agente revisa la casilla del sistema dentro del minuto siguiente y registra la revisión junto con los emails detectados.
- AC-93 (RF-100): Dado un Admin autenticado, cuando cambia el intervalo de revisión a un valor N entre 5 y 60 minutos, entonces a partir de la siguiente revisión programada las revisiones se ejecutan cada N minutos, con una tolerancia de ±1 minuto.
- AC-94 (RF-100): Dado un Admin autenticado, cuando intenta configurar el intervalo en 4 o en 61 minutos, entonces el sistema rechaza el valor y mantiene el intervalo anterior.
- AC-95 (RF-101, RF-102): Dada una revisión de la casilla que empezó a las 15:00 y todavía está en curso a las 15:15, cuando se cumple el intervalo de 15 minutos, entonces no se inicia otra revisión hasta que termine la anterior.
- AC-96 (RF-103): Dado el servidor IMAP sin responder dentro de 30 s (RNF-07), cuando el agente intenta revisar la casilla, entonces se registra un error de proceso Pendiente con la operación "revisión de la casilla".
- AC-97 (RF-103, RF-104): Dado el servidor IMAP sin responder durante tres intervalos de revisión seguidos, cuando el agente intenta revisar la casilla en cada intervalo, entonces realiza un intento de conexión por intervalo y hay un único error de proceso Pendiente de revisión de la casilla.
- AC-98 (RF-105, RF-106): Dado un error de proceso Pendiente de revisión de la casilla y dos emails de clientes llegados durante la falla, cuando la casilla vuelve a estar disponible en la siguiente revisión, entonces el agente procesa los dos emails y el error de proceso pasa a Resuelto.
- AC-99 (RF-107, RF-108): Dada una casilla con emails de un cliente recibidos antes y después del día de la primera factura emitida, cuando el agente la revisa por primera vez, entonces procesa solo los recibidos desde ese día; y en la revisión siguiente procesa solo los emails que llegaron después.
- AC-100 (RF-109): Dado un email ya procesado, cuando el agente lo vuelve a leer de la casilla con el mismo Message-ID, entonces no lo registra de nuevo en el historial, no lo envía al LLM y no cambia el estado de ninguna factura.
- AC-101 (RF-110): Dado un email recibido cuyo remitente es la casilla del sistema, cuando el agente revisa la casilla, entonces no se registra como aviso, no se envía al LLM y no cambia el estado de ninguna factura.
- AC-102 (RF-111, RF-113): Dado un email recibido cuyo remitente no coincide con el email de facturación de ningún cliente, cuando el agente lo procesa, entonces queda registrado como aviso Pendiente en la interfaz de revisión, no se envía al LLM y no cambia el estado de ninguna factura.
- AC-103 (RF-112): Dado un cliente con el email de facturación pagos@losandes.com, cuando llega un email desde Pagos@LosAndes.com, entonces el agente lo reconoce como del cliente y no lo registra como aviso.
- AC-104 (RF-114): Dado un email recibido desde el email de facturación de un cliente, cuando el agente lo procesa, entonces el email (fecha, asunto y adjuntos) queda registrado en el historial de ese cliente.
- AC-105 (RF-115): Dado un email recibido desde el email de facturación de un cliente sin ningún archivo adjunto, cuando el agente lo procesa, entonces no se envía al LLM y no cambia el estado de ninguna factura.
- AC-106 (RF-116): Dado un email de un cliente con deuda vigente cuyo único archivo es una imagen embebida en el cuerpo del mensaje, cuando el agente lo procesa, entonces se trata como un email sin adjunto (RF-115): no se envía al LLM y no cambia el estado de ninguna factura.
- AC-107 (RF-117): Dado un email de un cliente con deuda vigente cuyo único archivo adjunto es un .docx, cuando el agente lo procesa, entonces se trata como un email sin adjunto: no se envía al LLM y no cambia el estado de ninguna factura; y dado un email con un adjunto PNG y otro PDF, ambos se envían al LLM.
- AC-108 (RF-118): Dado un cliente Inactivo con una factura adeudada, cuando envía un comprobante clasificado como "si" con su CUIT y el monto exacto de esa factura, entonces la factura pasa a Pago recibido.

AC-109 a AC-111 evalúan al LLM real: se verifican fuera de la suite de tests automáticos (que mockea al LLM), con un set de prueba de al menos 20 adjuntos por cada clase ("si", "no" y "dudoso"). Cada AC pasa si se cumple su umbral.
- AC-109 (RF-119, RNF-14): Dado el set de adjuntos que muestran una transferencia legible con CUIT, fecha y monto, cuando el agente los procesa con el LLM, entonces al menos el 95 % se clasifica como "si" y ninguno se clasifica como "no".
- AC-110 (RF-119, RNF-14): Dado el set de adjuntos que no son un comprobante de pago, cuando el agente los procesa con el LLM, entonces al menos el 95 % se clasifica como "no".
- AC-111 (RF-119, RNF-14): Dado el set de adjuntos ilegibles o que no permiten determinar si se trata de un pago, cuando el agente los procesa con el LLM, entonces al menos el 95 % se clasifica como "dudoso".
- AC-112 (RF-120, RF-124): Dado un email con un adjunto clasificado como "si", cuando el agente termina de procesarlo, entonces el CUIT y el monto extraídos del comprobante quedan registrados en el historial del cliente junto con la clasificación.
- AC-113 (RF-120, RF-124, RF-123): Dado un email con tres adjuntos clasificados como "si", "si" y "no", cuando el agente termina de procesarlo, entonces quedan registrados en el historial del cliente la clasificación de cada adjunto, el CUIT y el monto de cada uno de los dos comprobantes y la clasificación del email "si".
- AC-114 (RF-121, RF-122): Dado un comprobante de transferencia en el que figuran el CUIT del ordenante y el CUIT del beneficiario (el del emisor de la factura), cuando el agente lo clasifica como "si", entonces el CUIT extraído es el del ordenante; y si el CUIT que se lee tiene menos de 11 dígitos, se registra como no extraído.
- AC-115 (RF-124): Dado un email con adjunto cuyo procesamiento quedó marcado como erróneo, cuando el agente termina de procesarlo, entonces la marca de procesamiento erróneo queda registrada en el historial del cliente.
- AC-116 (RNF-02): Dado un LLM que falla en los dos primeros intentos y en el tercero responde con una clasificación válida ("si", "no" o "dudoso"), cuando el agente procesa un email con un adjunto, entonces se realizan exactamente tres llamadas, con esperas de 2 s y 4 s entre ellas (±0,5 s cada una), y el email se procesa con la clasificación obtenida.
- AC-117 (RNF-02): Dado un LLM que responde HTTP 401, cuando el agente procesa un email con un adjunto, entonces se realiza una sola llamada y el procesamiento queda marcado como erróneo.
- AC-118 (RNF-02): Dado un LLM que responde HTTP 404, cuando el agente procesa un email con un adjunto, entonces se realiza una sola llamada y el procesamiento queda marcado como erróneo; y dado un LLM que responde HTTP 429 en el primer intento y en el segundo responde con una clasificación válida, se realizan dos llamadas y el email se procesa con la clasificación obtenida.
- AC-119 (RF-126): Dado un email clasificado como "no", cuando el agente termina de procesarlo, entonces la clasificación queda registrada, ninguna factura cambia de estado y no se envía ningún email.
- AC-120 (RF-127): Dado un cliente sin deuda vigente, cuando envía un comprobante clasificado como "si", entonces el comprobante queda registrado en su historial y ninguna factura cambia de estado.
- AC-121 (RF-127): Dado un cliente sin deuda vigente, cuando envía un email con adjunto clasificado como "dudoso", entonces el email queda registrado en su historial y ninguna factura cambia de estado.
- AC-122 (RF-128, RF-129, RF-138): Dado un cliente con una factura en Revisión manual y otra en Pendiente de pago, cuando envía un comprobante clasificado como "si" cuyo monto coincide exactamente con la factura Pendiente de pago, entonces ambas facturas quedan en Revisión manual con el motivo "revisión manual pendiente" (aunque la que ya estaba en Revisión manual tuviera otro motivo) y ninguna pasa a Pago recibido.
- AC-123 (RF-128, RF-129, RF-138): Dado un cliente con una factura en Revisión manual y otra en Pendiente de pago, cuando envía un email con adjunto cuyo procesamiento queda marcado como erróneo, entonces ambas facturas quedan en Revisión manual con el motivo "revisión manual pendiente".
- AC-124 (RF-139): Dado un cliente con una factura en Revisión manual que tiene un comprobante asociado, cuando envía un comprobante nuevo clasificado como "si", entonces la revisión manual del cliente queda con los dos comprobantes asociados.
- AC-125 (RF-130, RF-138): Dado un cliente con deuda vigente que no está en revisión y un LLM que responde HTTP 500 en los cuatro intentos, cuando el agente procesa un email con adjunto de ese cliente, entonces el procesamiento queda marcado como erróneo y las facturas adeudadas del cliente pasan a Revisión manual con el motivo "no se pudo procesar el comprobante".
- AC-126 (RF-131, RF-138): Dado un cliente con deuda vigente que no está en revisión, cuando envía un email clasificado como "dudoso", entonces sus facturas adeudadas pasan a Revisión manual con el motivo "clasificación dudosa".
- AC-127 (RF-123, RF-131): Dado un cliente con una sola factura adeudada de $10.000, en Pendiente de pago, cuando envía un email con dos adjuntos, uno clasificado como "si" con su CUIT por $10.000 y otro clasificado como "dudoso", entonces la factura pasa a Revisión manual con el motivo "clasificación dudosa" y no pasa a Pago recibido.
- AC-128 (RF-132, RF-138): Dado un cliente con deuda vigente que no está en revisión, cuando envía un comprobante clasificado como "si" del que no se puede extraer el CUIT, entonces sus facturas adeudadas pasan a Revisión manual con el motivo "no se pudieron extraer el CUIT o el monto" y ninguna pasa a Pago recibido.
- AC-129 (RF-132, RF-138): Dado un cliente con deuda vigente que no está en revisión, cuando envía un comprobante clasificado como "si" con su CUIT pero del que no se puede extraer el monto, entonces sus facturas adeudadas pasan a Revisión manual con el motivo "no se pudieron extraer el CUIT o el monto" y ninguna pasa a Pago recibido.
- AC-130 (RF-133, RF-138): Dado un cliente con deuda vigente que no está en revisión, cuando envía un comprobante clasificado como "si" cuyo CUIT no coincide con el suyo, entonces sus facturas adeudadas pasan a Revisión manual con el motivo "CUIT no coincide" y ninguna pasa a Pago recibido.
- AC-131 (RF-133): Dado un cliente con facturas adeudadas A de $100 y B de $200, ambas en Pendiente de pago, cuando envía un email con dos comprobantes clasificados como "si", uno con su CUIT por $100 y otro con un CUIT distinto por $200, entonces A y B pasan a Revisión manual con el motivo "CUIT no coincide" y ninguna pasa a Pago recibido.
- AC-132 (RF-125): Dado un cliente con el CUIT 30711111118, con deuda vigente y que no está en revisión, cuando llega un comprobante clasificado como "si" con el CUIT 30-71111111-8 y un monto exactamente igual al total de una de sus facturas adeudadas, entonces esa factura pasa a Pago recibido.
- AC-133 (RF-134): Dado un cliente con una sola factura adeudada, en Pendiente de pago, cuando llega un comprobante clasificado como "si" con su CUIT y un monto exactamente igual al total de esa factura, entonces la factura pasa a Pago recibido.
- AC-134 (RF-134): Dado un cliente con tres facturas adeudadas A, B y C de montos distintos, todas en Pendiente de pago, cuando llega un comprobante clasificado como "si" con su CUIT y un monto igual a A + C, y ninguna otra combinación suma ese monto, entonces A y C pasan a Pago recibido y B sigue en Pendiente de pago.
- AC-135 (RF-134): Dado un cliente con varias facturas adeudadas, todas en Pendiente de pago, cuando llega un comprobante clasificado como "si" con su CUIT y un monto igual a la suma de todas ellas, y ninguna otra combinación suma ese monto, entonces todas pasan a Pago recibido.
- AC-136 (RF-134, RF-123): Dado un cliente con una sola factura adeudada de $10.000, en Pendiente de pago, cuando envía un email con dos adjuntos, uno clasificado como "no" y otro clasificado como "si" con su CUIT por $10.000, entonces la factura pasa a Pago recibido.
- AC-137 (RF-134): Dado un cliente con facturas adeudadas A de enero por $100, B de febrero por $200 y C de marzo por $300, todas en Pendiente de pago, cuando envía un email con dos comprobantes clasificados como "si" con su CUIT, por $100 y por $200, entonces A y B pasan a Pago recibido (coincidencia por comprobante) y C sigue en Pendiente de pago, aunque la suma de los comprobantes ($300) coincida con C.
- AC-138 (RF-134): Dado un cliente con una sola factura adeudada A de $300, en Pendiente de pago, cuando envía un email con dos comprobantes clasificados como "si" con su CUIT, por $100 y por $200, entonces A pasa a Pago recibido (coincidencia por suma).
- AC-139 (RF-135): Dado un cliente con dos facturas adeudadas del mismo monto, de distintos meses, ambas en Pendiente de pago, cuando llega un comprobante clasificado como "si" con su CUIT y un monto igual al de una sola de ellas, entonces la factura más antigua pasa a Pago recibido y la más reciente sigue en Pendiente de pago.
- AC-140 (RF-135): Dado un cliente con facturas adeudadas de enero, febrero, marzo y abril, todas en Pendiente de pago, donde enero + abril y febrero + marzo suman lo mismo, cuando llega un comprobante clasificado como "si" con su CUIT por ese monto, entonces las facturas de enero y abril pasan a Pago recibido, y las de febrero y marzo siguen en Pendiente de pago.

AC-141 y AC-142 verifican una regla de resguardo que el flujo normal no produce (RF-51 y RF-74 generan una sola factura por cliente y período), por lo que se prueban con facturas cargadas directamente en la base de datos de prueba.
- AC-141 (RF-136, RF-138): Dado un cliente con dos facturas adeudadas del mismo período y el mismo monto, ambas en Pendiente de pago y cargadas directamente en la base de datos de prueba, cuando llega un comprobante clasificado como "si" con su CUIT por ese monto, entonces sus facturas adeudadas pasan a Revisión manual con el motivo "no se pudo determinar qué facturas cancela el pago" y ninguna pasa a Pago recibido.
- AC-142 (RF-136, RF-138): Dado un cliente con tres facturas adeudadas en Pendiente de pago, cargadas directamente en la base de datos de prueba: A de enero por $300, B de enero por $100 y C de febrero por $200, cuando llega un comprobante clasificado como "si" con su CUIT por $300, entonces sus facturas adeudadas pasan a Revisión manual con el motivo "no se pudo determinar qué facturas cancela el pago", porque la coincidencia A se queda sin facturas para comparar mientras B + C sigue.
- AC-143 (RF-137, RF-138): Dado un cliente con deuda vigente que no está en revisión, cuando llega un comprobante clasificado como "si" con su CUIT y un monto que no coincide con ninguna factura ni combinación de facturas (por ejemplo, un pago parcial), entonces sus facturas adeudadas pasan a Revisión manual con el motivo "monto no coincide" y ninguna pasa a Pago recibido.

### Revisión de pagos por el usuario
- AC-144 (RF-141): Dadas facturas en estado Pago recibido y Revisión manual, cuando un usuario autenticado abre la interfaz de revisión, entonces ve cada una de esas facturas con el email recibido, sus adjuntos, la clasificación del LLM de cada adjunto, el CUIT y el monto extraídos de cada comprobante y, para las de Revisión manual, el motivo; y no ve facturas en otros estados.
- AC-145 (RF-142): Dados avisos Pendientes y avisos Revisados, cuando un usuario autenticado abre la interfaz de revisión, entonces ve los avisos Pendientes con su remitente, asunto, fecha y adjuntos, y no ve los Revisados.
- AC-146 (RF-143): Dada una factura en estado Pago recibido, cuando un Admin o Editor confirma desde la interfaz de revisión que el pago se realizó, entonces la factura pasa a Pagada y deja de contar como factura adeudada del cliente.
- AC-147 (RF-144): Dada una factura en estado Pago recibido, cuando un Admin o Editor indica desde la interfaz de revisión que el pago no se realizó, entonces la factura vuelve a Pendiente de pago.
- AC-148 (RF-145): Dada una factura en estado Revisión manual, cuando un Admin o Editor confirma desde la interfaz de revisión que el pago se realizó, entonces la factura pasa a Pagada y deja de contar como factura adeudada del cliente.
- AC-149 (RF-146): Dada una factura en estado Revisión manual, cuando un Admin o Editor indica desde la interfaz de revisión que el pago no se realizó, entonces la factura vuelve a Pendiente de pago.
- AC-150 (RF-147): Dada una factura en estado Pendiente de pago, cuando un Admin o Editor la pasa a Pagada desde el listado de facturas, entonces la factura queda en estado Pagada, deja de contar como factura adeudada del cliente y el cambio queda registrado en el historial del cliente con el usuario que lo hizo.
- AC-151 (RF-140): Dada una factura en Revisión manual con el motivo "monto no coincide", cuando un Admin o Editor la pasa a Pagada o la devuelve a Pendiente de pago, entonces la factura deja de mostrar ese motivo.
- AC-152 (RF-144, RF-146, RF-134): Dada una factura que un usuario devolvió a Pendiente de pago y un cliente que no está en revisión, cuando llega después un comprobante clasificado como "si" con su CUIT y el monto exacto de esa factura, entonces el agente lo procesa y la factura pasa a Pago recibido.
- AC-153 (RF-148): Dado un aviso Pendiente, cuando un Admin o Editor lo marca como Revisado, entonces el aviso deja de aparecer entre los Pendientes y queda registrado qué usuario lo revisó.

### Recordatorios y dashboard
- AC-154 (RF-149): Dado un cliente Activo que no está en revisión y tiene al menos una factura en Pendiente de pago al último día del mes, cuando el agente ejecuta el proceso de recordatorios, entonces se envía un único email recordatorio a ese cliente y el envío queda registrado en su historial.
- AC-155 (RF-149): Dado un cliente Activo sin productos asignados, con al menos una factura en Pendiente de pago y que no está en revisión, cuando el agente ejecuta el proceso de recordatorios de fin de mes, entonces se envía un único email recordatorio a ese cliente.
- AC-156 (RF-149): Dado un cliente Activo en revisión al último día del mes, cuando el agente ejecuta el proceso de recordatorios, entonces no se envía ningún email a ese cliente.
- AC-157 (RF-149): Dada la hora de recordatorios por defecto, cuando llega el último día del mes, entonces el proceso de recordatorios se inicia a las 11:00 hora de Argentina, con una tolerancia de ±1 minuto.
- AC-158 (RF-150, RF-151): Dado un cliente con dos facturas adeudadas en Pendiente de pago, una de agosto por $10.000 y otra de septiembre por $12.000, cuando se le envía el recordatorio automático o el manual, entonces el email detalla ambas facturas con su número, período, importe y vencimiento, informa un total a pagar de $22.000 y le pide responder adjuntando el comprobante de pago.
- AC-159 (RF-152): Dado un Admin autenticado, cuando cambia la hora de recordatorios a 14:00, entonces el siguiente proceso de recordatorios de fin de mes se inicia a las 14:00 hora de Argentina, con una tolerancia de ±1 minuto.
- AC-160 (RF-152): Dado un Admin autenticado, cuando intenta configurar la hora de recordatorios en 23:40, entonces el sistema rechaza el valor y mantiene la hora anterior.
- AC-161 (RF-153): Dado un usuario autenticado, cuando abre el dashboard, entonces ve listados todos los clientes con deuda vigente, cada uno con su razón social, su deuda vigente total, la cantidad de facturas adeudadas y si está en revisión, y ningún cliente sin deuda vigente.
- AC-162 (RF-155): Dado un cliente cuyas facturas están todas en Pago recibido o Pagada, cuando el agente ejecuta el proceso de recordatorios de fin de mes, entonces no se envía ningún email a ese cliente.
- AC-163 (RF-156): Dado un cliente sin deuda vigente, cuando un usuario intenta enviar el recordatorio manual desde el dashboard, entonces el sistema bloquea la acción, no envía ningún email y muestra un mensaje indicando que el cliente no tiene deuda pendiente.
- AC-164 (RF-157): Dado un cliente en revisión, cuando un usuario intenta enviar el recordatorio manual desde el dashboard, entonces el sistema bloquea la acción, no envía ningún email y muestra un mensaje indicando que el cliente tiene un pago en revisión manual.

### Listados, historial y reportes
- AC-165 (RF-158): Dados un cliente Activo con deuda vigente de $22.000 y un cliente Inactivo sin deuda, cuando un usuario autenticado abre el listado de clientes, entonces ve ambos clientes con su razón social, CUIT, email de facturación, condición frente al IVA, estado y deuda vigente total ($22.000 y $0).
- AC-166 (RF-159): Dados un producto Activo en pesos y un producto Inactivo en dólares, cuando un usuario autenticado abre el listado de productos, entonces ve ambos con su nombre, precio, moneda y estado.
- AC-167 (RF-160): Dadas facturas en los cuatro estados, cuando un usuario autenticado abre el listado de facturas, entonces ve todas con su punto de venta y número, la razón social del cliente, el período, el total en pesos, el vencimiento del pago y el estado.
- AC-168 (RF-161): Dados un usuario Activo y uno Inactivo, cuando un Admin abre el listado de usuarios, entonces ve ambos con su nombre, email, perfil y estado.
- AC-169 (RF-162): Dada una factura emitida, cuando un usuario de cualquier perfil descarga su PDF desde el listado de facturas, entonces recibe un PDF con el contenido de RF-93 para esa factura.
- AC-170 (RF-163): Dado un cliente al que se le dio de alta, se le modificó la razón social, se le asignó un producto, se le generó y envió una factura, se registró un error de proceso de envío de su recordatorio automático de fin de mes, se le envió un recordatorio manual, respondió con un comprobante, un usuario pasó la factura a Pagada, y se lo dio de baja y se lo reactivó, cuando un usuario autenticado abre su historial, entonces ve cada uno de esos eventos en orden cronológico, con su fecha y hora y el usuario o el agente que lo originó.
- AC-171 (RF-164): Dadas tres facturas del período septiembre de 2026 por $10.000, $20.000 y $30.000, y dos del período octubre de 2026 por $5.000 cada una, cuando un usuario autenticado abre el reporte de facturación por período, entonces ve septiembre de 2026 con 3 facturas y $60.000, y octubre de 2026 con 2 facturas y $10.000.
- AC-172 (RF-165): Dadas cuatro facturas del período octubre de 2026: A por $10.000 Pagada, B por $20.000 en Pago recibido, C por $30.000 en Pendiente de pago y D por $40.000 en Revisión manual, cuando un usuario autenticado abre el reporte de cobranza por período, entonces ve octubre de 2026 con $100.000 facturado, $10.000 Pagada, $20.000 en Pago recibido y $70.000 adeudado.
- AC-173 (RF-166): Dados un cliente con dos facturas adeudadas por $10.000 y $12.000 y otro cliente sin deuda vigente, cuando un usuario autenticado abre el reporte de deuda por cliente, entonces ve al primero con una deuda vigente total de $22.000 y el detalle de las dos facturas (número, período, importe, vencimiento y estado), y no ve al segundo.
- AC-174 (RF-167): Dado cualquiera de los tres reportes abierto, cuando un usuario de cualquier perfil lo descarga como CSV, entonces el archivo contiene las mismas filas y columnas que el reporte en pantalla.
- AC-175 (RF-168): Dadas facturas de dos clientes, de septiembre y octubre de 2026 y en distintos estados, cuando un usuario autenticado filtra el listado de facturas por el estado Pendiente de pago, por uno de los clientes y por el período octubre de 2026, entonces ve solo las facturas que cumplen los tres filtros.
- AC-176 (RF-169): Dados un cliente Activo "Los Andes SA" con CUIT 30711111111 y un cliente Inactivo, cuando un usuario autenticado filtra el listado de clientes por el estado Inactivo, entonces ve solo el cliente Inactivo; y cuando busca "Andes" o "30711111111", ve solo a Los Andes SA.
- AC-177 (RF-170, RF-167): Dadas facturas de los períodos agosto, septiembre y octubre de 2026, cuando un usuario autenticado filtra el reporte de facturación o el de cobranza por el rango septiembre a octubre de 2026, entonces ve solo esos dos períodos, y el CSV descargado contiene solo esas filas.

### Errores de procesos automáticos
- AC-178 (RF-171): Dados la configuración de reintentos por defecto y el ambiente de homologación de ARCA que falla en el primer intento de generar la factura de un cliente y responde en el segundo, cuando el agente ejecuta el proceso de facturación, entonces el segundo intento ocurre 5 minutos (±1 minuto) después del primero, la factura queda generada y no se registra ningún error de proceso.
- AC-179 (RF-171, RF-174): Dados la configuración de reintentos por defecto y el ambiente de homologación de ARCA sin responder dentro de 30 s (RNF-07) en ningún intento, cuando el agente intenta generar la factura de un cliente, entonces realiza 4 intentos, no se genera la factura, no se envía email de factura y se registra un error de proceso Pendiente con el cliente, la operación "generación de factura", el período, 4 intentos y el último mensaje de error.
- AC-180 (RF-171, RF-174): Dados la configuración de reintentos por defecto y un servidor de email que rechaza todos los envíos a un cliente, cuando el agente intenta enviarle el email de su factura, entonces realiza 4 intentos, la factura queda en Pendiente de pago y se registra un error de proceso Pendiente con la operación "envío de factura".
- AC-181 (RF-171, RF-174): Dados la configuración de reintentos por defecto y un servidor de email que rechaza todos los envíos a un cliente, cuando el agente intenta enviarle el recordatorio automático de fin de mes, entonces realiza 4 intentos y se registra un error de proceso Pendiente con la operación "envío de recordatorio".
- AC-182 (RF-172): Dado un Admin autenticado, cuando configura la cantidad de reintentos en 0 y luego falla una operación, entonces el agente realiza un solo intento y registra el error de proceso.
- AC-183 (RF-172): Dado un Admin autenticado, cuando intenta configurar la cantidad de reintentos en 11, entonces el sistema rechaza el valor y mantiene la cantidad anterior.
- AC-184 (RF-173): Dado un Admin autenticado, cuando configura la espera entre reintentos en 10 minutos y luego falla una operación, entonces el siguiente intento ocurre 10 minutos (±1 minuto) después.
- AC-185 (RF-173): Dado un Admin autenticado, cuando intenta configurar la espera entre reintentos en 0 o en 61 minutos, entonces el sistema rechaza el valor y mantiene la espera anterior.
- AC-186 (RF-175): Dados errores de proceso Pendientes y Resueltos, cuando un usuario autenticado abre la interfaz de revisión, entonces ve los Pendientes con el cliente, la operación, el período, la cantidad de intentos y el último mensaje de error, y no ve los Resueltos.
- AC-187 (RF-176, RF-177, RF-179): Dado un error de proceso Pendiente de generación de factura y el ambiente de homologación de ARCA respondiendo, cuando un Admin o Editor lo reintenta manualmente, entonces la factura queda generada y el error de proceso pasa a Resuelto.
- AC-188 (RF-177, RF-84): Dado un error de proceso Pendiente de generación de factura y los servicios externos respondiendo, cuando un Admin o Editor lo reintenta manualmente y la factura se genera, entonces la factura se envía por email al email de facturación del cliente y el envío queda registrado en su historial.
- AC-189 (RF-178, RF-179): Dado un error de proceso Pendiente de envío de factura y el servidor de email respondiendo, cuando un Admin o Editor lo reintenta manualmente, entonces se envía el email de esa factura, no se genera ninguna factura nueva en ARCA y el error de proceso pasa a Resuelto.
- AC-190 (RF-176): Dado un error de proceso Pendiente y el servicio externo todavía fallando, cuando un Admin o Editor lo reintenta manualmente, entonces se realiza un único intento y el error de proceso sigue Pendiente con el nuevo mensaje de error.
- AC-191 (RF-180): Dado un error de proceso Pendiente, cuando un Admin o Editor lo marca como Resuelto, entonces deja de aparecer entre los Pendientes y queda registrado qué usuario lo resolvió.
- AC-192 (RF-181): Dados dos errores de proceso Pendientes, cuando un usuario autenticado abre el dashboard, entonces ve el banner de errores con la cantidad 2.
- AC-193 (RF-181): Dado un único error de proceso Pendiente, cuando pasa a Resuelto, entonces el banner de errores deja de mostrarse en el dashboard.
- AC-194 (RF-182, RF-183): Dado un servidor de email que rechaza el envío a un cliente con deuda vigente, cuando un usuario le envía un recordatorio manual desde el dashboard, entonces el sistema muestra un mensaje de error, realiza un único intento y no registra ningún error de proceso.

### Modo mock
- AC-195 (RF-184, RF-209): Dado MOCK_MODE=true, cuando un usuario autenticado abre cualquier pantalla, entonces el header muestra el indicador "Modo mock: ARCA, LLM y email simulados"; y dado MOCK_MODE=false o sin la variable, el indicador no se muestra.
- AC-196 (RF-185, RF-186): Dados el modo mock y el punto de venta 3 sin facturas emitidas en modo mock, cuando el agente genera dos facturas, entonces no se hace ninguna llamada a ARCA y las facturas quedan con los números 1 y 2 en el punto de venta 3, cada una con un CAE de 14 dígitos que vence 10 días después de su fecha de emisión.
- AC-197 (RF-187, RF-188, RF-189): Dados el modo mock y un cliente con el CUIT 30711111111 y una única factura adeudada de $15.000,50 en Pendiente de pago, cuando llega un email suyo con el adjunto `pago_30711111111_15000.50.pdf`, entonces no se llama a la API de Claude, el adjunto se clasifica como "si" con ese CUIT y ese monto, y la factura pasa a Pago recibido.
- AC-198 (RF-190): Dados el modo mock y un cliente con deuda vigente que no está en revisión, cuando llega un email suyo con el adjunto `PAGO_x_15000.50.PDF`, o con el adjunto `pago_30711111111_x.png`, entonces sus facturas adeudadas pasan a Revisión manual con el motivo "no se pudieron extraer el CUIT o el monto".
- AC-199 (RF-191, RF-192, RF-193): Dados el modo mock y un cliente con deuda vigente que no está en revisión, cuando llega un email suyo con el adjunto `dudoso_transferencia.jpg`, entonces sus facturas adeudadas pasan a Revisión manual con el motivo "clasificación dudosa"; con el adjunto `error_1.pdf`, con el motivo "no se pudo procesar el comprobante"; y con el adjunto `factura_proveedor.pdf`, el adjunto se clasifica como "no" y ninguna factura cambia de estado.
- AC-200 (RF-194, RF-195, RF-196, RF-197): Dado el modo mock, cuando el agente envía el email de una factura, entonces no se conecta a Gmail, y un Admin ve el email entre los enviados de la casilla simulada con el remitente aldebaran-mock@gmail.com, su destinatario, asunto, cuerpo, PDF adjunto y fecha de envío.
- AC-201 (RF-195, RF-110): Dado el modo mock, cuando un Admin carga en la casilla simulada un email recibido con el remitente aldebaran-mock@gmail.com, entonces en la siguiente revisión de la casilla el email no se registra como aviso, no se clasifica y no cambia el estado de ninguna factura.
- AC-202 (RF-199): Dado el modo mock, cuando un visitante abre la pantalla de inicio de sesión, entonces no ve la opción de recuperar la contraseña; y una solicitud directa al endpoint de recuperación es rechazada y no se guarda ningún email en la casilla simulada.
- AC-203 (RF-200, RF-201, RF-202, RF-203): Dados el modo mock y el intervalo de revisión por defecto, cuando un Admin o Editor carga un email recibido desde el email de facturación de un cliente, con asunto, cuerpo y un adjunto, entonces el email recibe un Message-ID único y como fecha de recepción el momento de la carga, no se procesa antes de la siguiente revisión de la casilla, esa revisión no se conecta a Gmail y en ella queda registrado en el historial del cliente con el resultado de su procesamiento.
- AC-204 (RF-205, RF-207): Dado MOCK_MODE=true como única variable de entorno definida, cuando arranca el sistema, entonces arranca, el agente ejecuta el proceso de facturación del día 15 y procesa los emails cargados en la casilla simulada.
- AC-205 (RF-206): Dados el modo mock y ARCA_CUIT sin definir, cuando el agente genera una factura, entonces el PDF muestra 20111111112 como CUIT del emisor; y con ARCA_CUIT definida, muestra ese valor.
- AC-206 (RF-208): Dados el modo mock y ningún certificado de ARCA configurado, cuando un usuario autenticado abre el dashboard, entonces no ve el banner de certificado.
- AC-207 (RF-210): Dado el modo mock, cuando el agente envía el email de una factura o un recordatorio, entonces el PDF de la factura y el cuerpo de cada email indican que fueron generados en modo mock y son simulados.
- AC-208 (RF-211, RF-212): Dados un cliente y una factura creados en modo mock, cuando el sistema se reinicia fuera del modo mock, entonces ni el cliente ni la factura aparecen; y dados un cliente y una factura creados fuera del modo mock, cuando el sistema se reinicia en modo mock, tampoco aparecen.
- AC-209 (RF-211): Dados MOCK_MODE=true y DATABASE_PATH apuntando a la base del modo real, cuando se crea un cliente en modo mock, entonces el cliente queda en data/aldebaran-mock.db y la base del modo real no cambia.
- AC-210 (RF-212, RF-213): Dados MOCK_MODE sin definir y DATABASE_PATH=data/aldebaran-mock.db, cuando se intenta arrancar el sistema, entonces no arranca, informa el error y data/aldebaran-mock.db no cambia.

### Control de acceso
- AC-211 (RF-01): Dado un visitante sin sesión iniciada, cuando intenta acceder a cualquier pantalla o endpoint distinto del inicio de sesión, la solicitud de recuperación de contraseña, la pantalla de cambio de contraseña con token y, mientras no exista ningún usuario, la pantalla de registro del primer Admin, entonces el sistema rechaza el acceso y no devuelve ningún dato.
- AC-212 (RF-05): Dado el sistema con al menos un usuario registrado, cuando un visitante intenta abrir la pantalla de registro del primer Admin o llamar a su endpoint, entonces el sistema rechaza el acceso y no se crea ningún usuario.
- AC-213 (RF-09, RF-11, RF-161): Dado un usuario con perfil Editor o Consulta, cuando intenta abrir el listado de usuarios o los datos de un usuario, entonces el sistema rechaza el acceso y no devuelve ningún dato de usuarios.
- AC-214 (RF-10): Dado un usuario con perfil Editor, cuando intenta crear, modificar, dar de baja o reactivar un usuario, entonces el sistema rechaza la acción y nada cambia.
- AC-215 (RF-10, RF-13): Dado un usuario con perfil Editor o Consulta, cuando intenta cambiar cualquier valor de la configuración (intervalo de revisión, hora de facturación, hora de recordatorios, cantidad de reintentos, espera entre reintentos, punto de venta o datos de la empresa emisora), entonces el sistema rechaza la acción y el valor no cambia.
- AC-216 (RF-10, RF-13, RF-54, RF-56, RF-58): Dado un usuario con perfil Editor o Consulta, cuando intenta cancelar la facturación de un período, reactivar la de un período cancelado o ejecutar "Facturar ahora", entonces el sistema rechaza la acción, el período no cambia y no se genera ninguna factura.
- AC-217 (RF-13): Dado un usuario con perfil Consulta, cuando intenta crear, modificar, dar de baja, desactivar o reactivar un usuario (salvo cambiar su propia contraseña), cliente, producto o asignación, cambiar el estado de una factura, marcar un aviso como Revisado, confirmar la cotización de respaldo, o reintentar o marcar como Resuelto un error de proceso, entonces el sistema rechaza la acción y el registro no cambia.
- AC-218 (RF-21): Dado un usuario autenticado de cualquier perfil, cuando envía al endpoint de cambio de contraseña una solicitud que indica a otro usuario, entonces el sistema rechaza la acción y la contraseña del otro usuario no cambia.
- AC-219 (RF-200, RF-13): Dado el modo mock, cuando un usuario Consulta intenta cargar un email recibido en la casilla simulada, entonces el sistema rechaza la acción y no se crea ningún email.
- AC-220 (RF-204): Dado el sistema fuera del modo mock, cuando un Admin intenta abrir la casilla simulada o cargar un email en ella por endpoint, entonces el sistema rechaza el acceso y no se crea ningún email.
- AC-221 (RF-198, RF-197): Dado el modo mock, con un email enviado a un cliente y un email recibido desde el email de facturación de un cliente en la casilla simulada, cuando un Editor o un usuario Consulta abre la casilla simulada, entonces ve solo el email recibido; y cuando la abre un Admin, ve los dos.

### Requerimientos no funcionales
- AC-222 (RNF-10): Dado un usuario autenticado sin actividad durante 24 h, cuando realiza una nueva acción, entonces el sistema le exige iniciar sesión de nuevo.
- AC-223 (RNF-10): Dado un usuario autenticado cuya última actividad fue hace 23 h, cuando realiza una nueva acción, entonces la acción se ejecuta sin pedirle que inicie sesión.
- AC-224 (RNF-09): Dado un usuario dado de alta con una contraseña, cuando se lee su registro en la base de datos, entonces el campo de contraseña tiene un hash bcrypt con costo ≥ 12 o un hash argon2id, y no contiene la contraseña en texto plano.
- AC-225 (RNF-08, RNF-11): Dado el repositorio con todo su historial, cuando se ejecuta gitleaks (herramienta gratuita y de código abierto) con su configuración por defecto, entonces no reporta ningún hallazgo.
- AC-226 (RNF-08): Dada la variable de entorno ANTHROPIC_API_KEY con un valor de prueba, cuando el agente llama al LLM (mockeado), entonces la llamada usa ese valor.
- AC-227 (RNF-11): Dadas las variables de entorno GMAIL_USER, GMAIL_APP_PASSWORD, ARCA_CUIT, ARCA_CERT_PATH y ARCA_KEY_PATH con valores de prueba, cuando el agente se conecta a la casilla de email y a ARCA (mockeados), entonces usa esos valores.
- AC-228 (RNF-07): Dados ARCA, el servidor de email y dolarhoy.com mockeados sin responder, cuando el agente hace una llamada a cada uno, entonces da la llamada por fallida a los 30 s, 30 s y 10 s respectivamente (±1 s).
- AC-229 (RNF-12): Dado un servidor con el reloj del sistema en UTC y la hora de facturación por defecto (11:00), cuando llega el día 15, entonces el proceso de facturación no se inicia a las 11:00 UTC (08:00 en Argentina) y sí se inicia a las 14:00 UTC (11:00 en Argentina).
- AC-230 (RNF-13): Dado un cliente con una sola factura adeudada de $15.000,00, en Pendiente de pago, cuando llega un comprobante clasificado como "si" con su CUIT y un monto de $15.000,01, entonces la factura pasa a Revisión manual con el motivo "monto no coincide".
- AC-231 (RNF-13): Dado un cliente con deuda vigente que no está en revisión, cuando llega un comprobante clasificado como "si" con su CUIT y un monto de $0, entonces sus facturas adeudadas pasan a Revisión manual con el motivo "monto no coincide".

AC-232 a AC-234 son pruebas de rendimiento: se verifican fuera de la suite de tests automáticos, contra el LLM real, el ambiente de homologación de ARCA y una casilla de email de prueba (los clientes del ensayo tienen direcciones de prueba como email de facturación).
- AC-232 (RNF-01): Dado un set de al menos 100 emails de respuesta con adjunto, cuando el agente los procesa con el LLM real, entonces el p95 del tiempo entre la detección de cada email y el registro de su resultado es menor a 60 s.
- AC-233 (RNF-03, RNF-05): Dados 50 clientes Activos, cada uno con 2 productos asignados de un catálogo de 10 productos, cuando el proceso de facturación se ejecuta el día 15, entonces las 50 facturas quedan generadas en el ambiente de homologación de ARCA y sus 50 emails enviados en 20 minutos o menos desde el inicio del proceso.
- AC-234 (RNF-04, RNF-06): Dados 50 clientes Activos con deuda vigente que no están en revisión, cuando el proceso de recordatorios se ejecuta el último día del mes, entonces los 50 recordatorios quedan enviados en 20 minutos o menos desde el inicio del proceso.

## Fuera de Alcance
- Facturación real/productiva contra ARCA: en este MVP se factura contra el ambiente de homologación de ARCA; la emisión de comprobantes fiscales válidos en el ambiente productivo queda fuera de alcance y se evaluará en una fase posterior.
- Consulta o integración con sistemas bancarios para validar pagos (por ejemplo, consultas de movimientos de cuenta): la única fuente para detectar pagos es el email del cliente.
- Notas de crédito y anulación de facturas no están contempladas en este MVP.
- Edición o regeneración de facturas ya emitidas.
- Comprobantes distintos de la Factura C (por ejemplo, Factura A o B).
- Prorrateo de cuotas por altas, bajas o asignaciones a mitad de mes: cada factura incluye la cuota mensual completa de cada producto Activo asignado.
- El cálculo y aplicación de intereses por mora sobre deudas vencidas no está contemplado en este MVP.
- Portal o acceso al sistema para los clientes.
- Reglas de contraseña adicionales al mínimo de 8 caracteres (complejidad, historial de contraseñas, vencimiento periódico).
- Bloqueo de cuentas por intentos fallidos de inicio de sesión y límite de solicitudes de recuperación de contraseña.
- Recuperación de los recordatorios automáticos de fin de mes que no se enviaron porque el sistema no estaba funcionando ese día.
- Respaldos automáticos de la base de datos.
- Filtros, búsquedas y ordenamientos de listados y reportes distintos de los de RF-168 a RF-170.
- Recuperación de contraseña en modo mock.
- Migrar o copiar datos entre la base del modo mock y la del modo real.
- Simulación de fallas de ARCA en modo mock: el ARCA simulado autoriza todas las facturas.
- Activar el modo mock por servicio (por ejemplo, simular solo ARCA): MOCK_MODE simula ARCA, el LLM y el email juntos.
- Simulación de dolarhoy.com en modo mock: la cotización se sigue leyendo del sitio real.

## Riesgos y Dependencias
- Riesgo: la factura no se puede generar en el ambiente de homologación de ARCA → mitigación: reintentos configurables (RF-171) y, si persiste, error de proceso en la interfaz de revisión y banner de errores en el dashboard (RF-174 a RF-181).
- Riesgo: vence el certificado de ARCA y no se puede facturar → mitigación: banner de certificado en el dashboard, con aviso 30 días antes del vencimiento (RF-98) y cuando ya venció (RF-97) y, si igual se intenta facturar, error de proceso por cada factura (RF-171 a RF-181).
- Riesgo: no se pueden enviar los emails → mitigación: la misma que para ARCA (RF-171 a RF-181).
- Riesgo: no se puede leer la casilla de email → mitigación: error de proceso y nuevo intento en cada intervalo de revisión hasta que se restablezca (RF-103 a RF-106).
- Riesgo: el LLM clasifica mal un adjunto o extrae mal el CUIT o el monto → mitigación: el agente nunca pasa una factura a Pagada; todo pago validado queda en Pago recibido y todo caso dudoso en Revisión manual, para que un usuario lo confirme o lo rechace (RF-143 a RF-146).
- Riesgo: la API de Claude no responde → mitigación: reintentos (RNF-02) y, si persiste, las facturas adeudadas del cliente pasan a Revisión manual (RF-130).
- Riesgo: con muchas facturas adeudadas o muchos comprobantes en un email, la búsqueda de coincidencias de monto crece de forma exponencial (por ejemplo, 25 facturas adeudadas suman unos 33 millones de combinaciones) y podría superar el límite de RNF-01 → mitigación: ninguna en este MVP; riesgo aceptado.
- Riesgo: dolarhoy.com no responde o cambia su formato al momento de facturar (no es una API oficial) → mitigación: usar la última cotización registrada y mostrar el banner de cotización para que un usuario la confirme (RF-67, RF-69 y RF-70); si no hay ninguna cotización registrada, no se genera la factura y se trata como error de proceso (RF-68, RF-171).
- Riesgo: para facturar en producción, el PDF debe cumplir los requisitos de ARCA para comprobantes impresos (por ejemplo, el código QR de RG 4892), que este MVP no incluye → mitigación: completarlos antes de pasar a producción, junto con los datos de la empresa emisora (RF-91).
- Riesgo: la cotización del dólar blue de una fuente no oficial (dolarhoy.com) podría no ser válida para emitir una factura legal → mitigación: confirmar con el contador si esta modalidad es válida antes de pasar a facturación real en producción; mientras tanto, dejar registrada en cada factura la fuente y el valor de cotización utilizado para poder auditarlo.
- Riesgo: MOCK_MODE queda activado por error en el ambiente real y la facturación real, los recordatorios y la revisión de la casilla dejan de ejecutarse → mitigación: indicador de modo mock en el header (RF-209) y base de datos propia del modo mock, que deja intactos los datos del modo real (RF-211, RF-212).
- Riesgo: sin conexión a internet, en modo mock no se puede leer la cotización de dolarhoy.com y, con la base mock vacía, no hay ninguna cotización registrada, por lo que no se pueden facturar productos con precio en dólares (RF-68) → mitigación: para evaluar sin internet, usar productos con precio en pesos.
- Dependencia: API de Claude · Gmail (SMTP e IMAP) · SQLite · ambiente de homologación de ARCA · dolarhoy.com (cotización del dólar blue). En modo mock, el sistema no depende de la API de Claude, de Gmail ni de ARCA.

