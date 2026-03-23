import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Términos de Servicio — TKOC Intelligence',
}

export default function TermsOfServicePageES() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <div className="mb-6 flex items-center justify-end gap-2 text-sm">
        <a href="/terms" className="text-gray-500 hover:text-purple-600">English</a>
        <span className="text-gray-300">|</span>
        <span className="font-medium text-purple-700 border-b-2 border-purple-700 pb-0.5">Español</span>
      </div>
      <h1 className="text-3xl font-bold text-gray-900 mb-2">Términos de Servicio</h1>
      <p className="text-sm text-gray-500 mb-10">Última actualización: 23 de marzo de 2026</p>

      <div className="prose prose-gray max-w-none space-y-8 text-gray-700 leading-relaxed">
        <section>
          <h2 className="text-xl font-semibold text-gray-900">1. Aceptación de los Términos</h2>
          <p>
            Al acceder o utilizar TKOC Intelligence (&quot;el Servicio&quot;), operado por DAMA Platforms S.L.
            (&quot;TKOC&quot;, &quot;nosotros&quot;, &quot;nuestro&quot;), usted acepta quedar vinculado por los presentes
            Términos de Servicio. Si no está de acuerdo con estos términos, no podrá utilizar el Servicio.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">2. Descripción del Servicio</h2>
          <p>
            TKOC Intelligence es una plataforma de inteligencia de marketing de influencers que ayuda a marcas
            y agencias a gestionar campañas, realizar el seguimiento del rendimiento del contenido, analizar
            métricas de influencers y generar información estratégica para la toma de decisiones basada en datos.
            El Servicio se integra con plataformas de redes sociales, incluyendo Instagram (a través de la
            Meta Graph API) y YouTube (a través de la YouTube Data API), para proporcionar capacidades de
            análisis y generación de informes.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">3. Cuentas de Usuario</h2>
          <p>
            El acceso al Servicio requiere una invitación de un administrador autorizado. Al crear una cuenta,
            usted se compromete a:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Proporcionar información de registro veraz y completa</li>
            <li>Mantener la confidencialidad de sus credenciales de acceso</li>
            <li>Asumir la responsabilidad de todas las actividades realizadas con su cuenta</li>
            <li>Notificarnos de inmediato cualquier uso no autorizado de su cuenta</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">4. Roles de Usuario y Permisos</h2>
          <p>El Servicio contempla tres roles de usuario con diferentes niveles de acceso:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Administrador:</strong> acceso completo a todas las funcionalidades, configuraciones, integraciones y gestión de usuarios</li>
            <li><strong>Empleado:</strong> acceso a campañas, gestión de influencers y funcionalidades de informes</li>
            <li><strong>Marca:</strong> acceso de solo lectura a las campañas asignadas, con capacidades de edición limitadas</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">5. Integración con Redes Sociales</h2>
          <p>
            Al conectar cuentas de redes sociales (Instagram, YouTube) al Servicio, usted nos autoriza
            a acceder a los datos públicos de su perfil y a las métricas de su contenido, tal y como se
            describe en nuestra Política de Privacidad. Puede desconectar sus cuentas en cualquier momento
            a través de la página de Configuración.
          </p>
          <p>
            Usted declara que tiene la autoridad necesaria para conectar cualquier cuenta que vincule al
            Servicio y que hacerlo no vulnera ningún acuerdo suscrito con las respectivas plataformas.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">6. Invitaciones a Creadores e Influencers</h2>
          <p>
            El Servicio permite a los usuarios autorizados invitar a creadores e influencers a conectar
            sus perfiles de redes sociales. Al aceptar una invitación y conectar su perfil, usted consiente
            la recopilación y el tratamiento de los datos públicos de su perfil y las métricas de su contenido,
            tal y como se describe en nuestra Política de Privacidad. Puede revocar este consentimiento
            en cualquier momento.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">7. Uso Aceptable</h2>
          <p>Usted se compromete a no:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Utilizar el Servicio para infringir leyes o normativas</li>
            <li>Acceder a datos o cuentas no autorizados para su rol</li>
            <li>Intentar eludir las medidas de seguridad</li>
            <li>Compartir las credenciales de acceso con personas no autorizadas</li>
            <li>Utilizar el Servicio para acosar, difamar o perjudicar a cualquier persona</li>
            <li>Realizar ingeniería inversa o intentar extraer el código fuente del Servicio</li>
            <li>Utilizar el Servicio en contravención de los términos de servicio de cualquier plataforma de redes sociales</li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">8. Propiedad Intelectual</h2>
          <p>
            El Servicio, incluyendo su diseño, código, algoritmos (Creator Score, Deal Advisor, Risk Signals,
            Campaign Intelligence, Repeat Radar) y marca, es propiedad intelectual de DAMA Platforms S.L.
            Todos los derechos reservados.
          </p>
          <p>
            Los datos de campañas y los informes generados por los usuarios siguen siendo propiedad de los
            respectivos usuarios y sus organizaciones.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">9. Datos y Privacidad</h2>
          <p>
            El uso del Servicio se rige también por nuestra <a href="/privacy/es" className="text-purple-600 underline">Política de Privacidad</a>,
            que describe cómo recopilamos, utilizamos y protegemos sus datos. Al utilizar el Servicio,
            usted consiente las prácticas descritas en la Política de Privacidad.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">10. Disponibilidad del Servicio</h2>
          <p>
            Nos esforzamos por mantener una alta disponibilidad, pero no garantizamos un acceso ininterrumpido.
            Podemos suspender temporalmente el Servicio por motivos de mantenimiento, actualizaciones o
            circunstancias imprevistas. Realizaremos esfuerzos razonables para notificar a los usuarios
            de las interrupciones planificadas.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">11. Limitación de Responsabilidad</h2>
          <p>
            El Servicio se proporciona &quot;tal cual&quot;, sin garantía de ningún tipo. TKOC no será responsable
            de daños indirectos, incidentales o consecuentes derivados del uso del Servicio.
            Nuestra responsabilidad total no excederá el importe abonado por usted por el Servicio durante
            los doce meses anteriores a la reclamación.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">12. Resolución</h2>
          <p>
            Podemos suspender o cancelar su acceso al Servicio en cualquier momento por incumplimiento
            de estos Términos. Tras la resolución, sus datos serán tratados conforme a nuestra Política
            de Privacidad. Puede solicitar la eliminación de todos sus datos poniéndose en contacto con
            admon@thekingofcontent.agency.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">13. Legislación Aplicable</h2>
          <p>
            Los presentes Términos se rigen por la legislación española. Cualquier controversia será
            resuelta ante los tribunales de Madrid, España.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">14. Modificación de los Términos</h2>
          <p>
            Podemos actualizar estos Términos periódicamente. El uso continuado del Servicio tras las
            modificaciones implica su aceptación. Notificaremos a los usuarios de los cambios sustanciales
            mediante correo electrónico.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-900">15. Contacto</h2>
          <p>
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
