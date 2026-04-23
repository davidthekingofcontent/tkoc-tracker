import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Política de Privacidad — TKOC Intelligence',
}

export default function PrivacyPolicyPageES() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <div className="mb-6 flex items-center justify-end gap-2 text-sm">
        <a href="/privacy" className="text-gray-500 hover:text-purple-600">English</a>
        <span className="text-gray-300">|</span>
        <span className="font-medium text-purple-700 border-b-2 border-purple-700 pb-0.5">Español</span>
      </div>
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Política de Privacidad</h1>
      <p className="text-sm text-gray-500 mb-10">Última actualización: 23 de marzo de 2026</p>

      <div className="prose prose-gray max-w-none space-y-8 text-gray-700 leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-gray-900">1. Introducción</h2>
          <p>
            TKOC Intelligence (&quot;nosotros&quot;, &quot;nuestro&quot;, &quot;nos&quot;) es una plataforma de inteligencia
            de marketing de influencers operada por DAMA Platforms S.L. (&quot;TKOC&quot;). La presente Política
            de Privacidad describe cómo recopilamos, utilizamos, almacenamos y protegemos los datos personales
            cuando usted utiliza nuestra plataforma en tkoc-tracker-production.up.railway.app (el &quot;Servicio&quot;).
          </p>
          <p>
            Nos comprometemos a proteger su privacidad y a cumplir con el Reglamento General de Protección
            de Datos (RGPD), la Ley Orgánica de Protección de Datos Personales y garantía de los derechos
            digitales (LOPDGDD) y toda la legislación aplicable en materia de protección de datos.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">2. Responsable del Tratamiento</h2>
          <p>
            DAMA Platforms S.L.<br />
            CIF: B56551146<br />
            C/ Sector Pueblos 23, 5B — 28760 Tres Cantos, Madrid, España<br />
            Correo electrónico: admon@thekingofcontent.agency
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">3. Datos que Recopilamos</h2>
          <h3 className="text-lg font-medium text-gray-800 mt-4">3.1 Datos de la Cuenta</h3>
          <p>Cuando usted se registra o es invitado a la plataforma, recopilamos:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Nombre y dirección de correo electrónico</li>
            <li>Contraseña (cifrada con bcrypt, nunca almacenada en texto plano)</li>
            <li>Asignación de rol (Administrador, Empleado o Marca)</li>
          </ul>

          <h3 className="text-lg font-medium text-gray-800 mt-4">3.2 Datos de Redes Sociales (a través de la API de Meta/Instagram)</h3>
          <p>Cuando usted conecta su cuenta de Instagram o autoriza el acceso, podemos recopilar:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Información del perfil de cuenta Business/Creator de Instagram (nombre de usuario, biografía, foto de perfil, número de seguidores)</li>
            <li>Metadatos de contenido multimedia (URLs de publicaciones, descripciones, métricas de interacción como &quot;me gusta&quot;, comentarios, visualizaciones, compartidos, guardados)</li>
            <li>Información agregada de la audiencia (datos demográficos agregados — rangos de edad, distribución por género, regiones geográficas)</li>
            <li>Datos de rendimiento del contenido (alcance, impresiones, tasas de interacción)</li>
          </ul>
          <p>
            <strong>NO recopilamos:</strong> mensajes privados, información de pago de plataformas sociales,
            listas de contactos personales ni ningún dato de cuentas que no sean de tipo Business o Creator.
          </p>

          <h3 className="text-lg font-medium text-gray-800 mt-4">3.3 Datos de YouTube (a través de la API de YouTube Data)</h3>
          <p>Accedemos a datos de YouTube disponibles públicamente, incluyendo:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Información del canal (nombre, número de suscriptores, descripción)</li>
            <li>Metadatos de vídeos (títulos, visualizaciones, &quot;me gusta&quot;, comentarios, fechas de publicación)</li>
          </ul>

          <h3 className="text-lg font-medium text-gray-800 mt-4">3.4 Datos de Campañas</h3>
          <p>Datos generados a través del uso de la plataforma:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Configuraciones de campañas (nombres, fechas, hashtags y cuentas monitorizadas)</li>
            <li>Detalles de colaboración con influencers (tarifas, estado, entrega de contenido)</li>
            <li>Análisis de rendimiento e informes</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">4. Cómo Utilizamos sus Datos</h2>
          <p>Utilizamos los datos recopilados exclusivamente para:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Gestión de Campañas:</strong> seguimiento del rendimiento del contenido de influencers en campañas autorizadas</li>
            <li><strong>Análisis e Informes:</strong> generación de informes de rendimiento (EMV, tasas de interacción, análisis de CPM)</li>
            <li><strong>Funciones de Inteligencia:</strong> cálculos de Creator Score, análisis de precios del Deal Advisor, detección de Risk Signals</li>
            <li><strong>Operación de la Plataforma:</strong> autenticación de usuarios, notificaciones y funcionalidad general de la plataforma</li>
          </ul>
          <p>
            <strong>No</strong> vendemos, alquilamos ni compartimos datos personales con terceros con fines comerciales.
            <strong>No</strong> utilizamos los datos para segmentación publicitaria ni para la elaboración de perfiles
            fuera del ámbito del Servicio.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">5. Base Legal del Tratamiento</h2>
          <p>De conformidad con el RGPD, tratamos los datos sobre la base de:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Consentimiento:</strong> cuando usted conecta una cuenta de redes sociales o autoriza el acceso a los datos</li>
            <li><strong>Ejecución contractual:</strong> para prestar el Servicio conforme a lo acordado</li>
            <li><strong>Interés legítimo:</strong> para la seguridad de la plataforma, la prevención del fraude y la mejora del servicio</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">6. Comunicación de Datos</h2>
          <p>Podemos compartir datos con:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Meta Platforms, Inc.:</strong> según lo requerido por los términos de la API de Instagram/Facebook</li>
            <li><strong>Google LLC:</strong> según lo requerido por los términos de la API de YouTube</li>
            <li><strong>Proveedores de infraestructura:</strong> Railway (alojamiento), PostgreSQL (base de datos) — sujetos a acuerdos de encargo de tratamiento</li>
          </ul>
          <p>No compartimos datos con ningún otro tercero.</p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">7. Conservación de Datos</h2>
          <p>
            Conservamos los datos de la cuenta mientras esta permanezca activa. Los datos de las campañas
            se conservan mientras la campaña exista. Cuando se elimina una campaña, todos los datos asociados
            (contenido multimedia, asignaciones de influencers, notas, archivos) se eliminan de forma permanente
            e irreversible mediante eliminación en cascada.
          </p>
          <p>
            Usted puede solicitar la eliminación de su cuenta y de todos los datos asociados en cualquier
            momento poniéndose en contacto con admon@thekingofcontent.agency o utilizando el punto de acceso
            de eliminación de datos.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">8. Sus Derechos (RGPD)</h2>
          <p>Usted tiene derecho a:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Acceso:</strong> solicitar una copia de sus datos personales</li>
            <li><strong>Rectificación:</strong> corregir datos inexactos</li>
            <li><strong>Supresión:</strong> solicitar la eliminación de sus datos (&quot;derecho al olvido&quot;)</li>
            <li><strong>Limitación del tratamiento:</strong> restringir la forma en que tratamos sus datos</li>
            <li><strong>Portabilidad:</strong> recibir sus datos en un formato legible por máquina</li>
            <li><strong>Oposición:</strong> oponerse al tratamiento de datos basado en el interés legítimo</li>
            <li><strong>Retirada del consentimiento:</strong> revocar en cualquier momento cualquier consentimiento previamente otorgado</li>
          </ul>
          <p>Para ejercer estos derechos, contacte con: admon@thekingofcontent.agency</p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">9. Seguridad de los Datos</h2>
          <p>Implementamos medidas de seguridad adecuadas, incluyendo:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Contraseñas cifradas (hash con bcrypt)</li>
            <li>Tokens y secretos de API cifrados (AES-256-GCM)</li>
            <li>Comunicación exclusivamente a través de HTTPS</li>
            <li>Control de acceso basado en roles (Administrador, Empleado, Marca)</li>
            <li>Gestión segura de sesiones mediante tokens JWT</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">10. Eliminación de Datos</h2>
          <p>
            Para solicitar la eliminación de todos sus datos, puede:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Enviar un correo electrónico a admon@thekingofcontent.agency</li>
            <li>Utilizar el punto de acceso automatizado de eliminación de datos en /api/data-deletion</li>
            <li>Desconectar sus cuentas de redes sociales desde Ajustes → Integraciones</li>
            <li>
              Eliminar la aplicación TKOC Intelligence desde su cuenta de Facebook — esto dispara una
              eliminación automática de todos los datos de Meta/Instagram que tenemos de su cuenta
              mediante nuestro webhook firmado de Meta Data Deletion.
            </li>
          </ul>
          <p>
            Tras recibir una solicitud de eliminación válida, eliminaremos todos los datos personales
            en un plazo de 30 días y confirmaremos la eliminación. Para eliminaciones iniciadas por Meta,
            devolvemos un código de confirmación consultable en /data-deletion.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">11. Cookies</h2>
          <p>
            Utilizamos únicamente cookies esenciales necesarias para la autenticación y la gestión de sesiones.
            No utilizamos cookies de seguimiento, cookies analíticas ni cookies publicitarias.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">12. Modificaciones de esta Política</h2>
          <p>
            Podemos actualizar esta Política de Privacidad periódicamente. Notificaremos a los usuarios
            de los cambios significativos mediante correo electrónico o notificación dentro de la aplicación.
            El uso continuado del Servicio tras las modificaciones implica la aceptación de la política actualizada.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">13. Contacto</h2>
          <p>
            Para consultas sobre esta Política de Privacidad o la protección de datos:<br />
            DAMA Platforms S.L.<br />
            CIF: B56551146<br />
            C/ Sector Pueblos 23, 5B — 28760 Tres Cantos, Madrid, España<br />
            Correo electrónico: admon@thekingofcontent.agency
          </p>
        </section>
      </div>
    </div>
  )
}
