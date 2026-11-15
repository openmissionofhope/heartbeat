/**
 * The consent conversation (docs/03 §3.3), version-stamped. DRAFT: needs plain-language testing
 * with people with lived experience and review by North Carolina counsel before real use. The
 * Spanish text needs review by a fluent speaker.
 */
export const CONSENT_POINTS: { en: string; es: string }[] = [
  {
    en: 'What it is: if you sign up and we don’t see or hear from you for about the time you choose, a named person here will try to reach you, in the ways you pick.',
    es: 'Qué es: si se inscribe y no le vemos ni sabemos de usted durante el tiempo que elija, una persona de aquí, con nombre, intentará comunicarse con usted de las maneras que usted escoja.',
  },
  {
    en: 'What it isn’t: it is not emergency help. We work only during our staffed hours. We can’t promise to find you, and it doesn’t keep you safe. If we can’t operate — for example after a disaster — follow-up may stop until we can. In an emergency, call 911.',
    es: 'Qué no es: no es ayuda de emergencia. Trabajamos solo en nuestro horario. No podemos prometer encontrarle, y esto no le mantiene a salvo. Si no podemos operar —por ejemplo, después de un desastre— el seguimiento puede detenerse hasta que podamos. En una emergencia, llame al 911.',
  },
  {
    en: 'Your choice: you don’t have to. Nothing you get here changes if you say no or stop later. It has nothing to do with church or religion.',
    es: 'Usted decide: no tiene que hacerlo. Nada de lo que recibe aquí cambia si dice que no o si deja de participar. No tiene nada que ver con la iglesia ni con la religión.',
  },
  {
    en: 'What we keep: the name you want us to use, other names if you want, the dates we saw or heard from you, the plan you pick, and what we did to reach you. We don’t keep where you go, immigration information, ID numbers or health records.',
    es: 'Lo que guardamos: el nombre que quiere que usemos, otros nombres si lo desea, las fechas en que le vimos o supimos de usted, el plan que escoja y lo que hicimos para comunicarnos. No guardamos a dónde va, información de inmigración, números de identificación ni expedientes médicos.',
  },
  {
    en: 'Who sees it: only staff here who need it. Every look is recorded and you can ask to see who looked. We will not tell anyone who asks whether you’re signed up. There is no way for police or immigration to get into this system, and we don’t share it with them. But a court can sometimes order records, and then we may have to hand them over — that’s one reason we keep so little.',
    es: 'Quién lo ve: solo el personal de aquí que lo necesita. Cada consulta queda registrada y puede pedir ver quién miró. No le diremos a nadie que pregunte si usted está inscrito. La policía y las autoridades de inmigración no tienen manera de entrar en este sistema, y no lo compartimos con ellas. Pero a veces un tribunal puede ordenar que entreguemos registros, y entonces podríamos tener que hacerlo; por eso guardamos tan poco.',
  },
  {
    en: 'Reports we must make: if you tell us about abuse of a child, about abuse by a partner, or about a disabled adult who needs protection, we must report it — to police for child abuse and partner abuse (and to county social services for a child), and to county social services for a disabled adult. We never report anyone about immigration.',
    es: 'Reportes que debemos hacer: si nos cuenta sobre abuso de un niño o una niña, sobre abuso por parte de una pareja, o sobre un adulto con discapacidad que necesita protección, debemos reportarlo: a la policía en casos de abuso infantil y de abuso de pareja (y a los servicios sociales del condado si se trata de un menor), y a los servicios sociales del condado si se trata de un adulto con discapacidad. Nunca reportamos a nadie por asuntos de inmigración.',
  },
  {
    en: 'Your controls: you choose the plan, who we may ask about you, and what follow-up we do. You can pause, stop, or see your record at any time. If you ask to stop by phone or message, we will stop contacting you right away and confirm with you in person the next time we see you before your record is deleted.',
    es: 'Usted controla: escoge el plan, a quién podemos preguntar por usted y qué seguimiento hacemos. Puede hacer una pausa, dejar de participar o ver su expediente en cualquier momento. Si pide dejar de participar por teléfono o mensaje, dejaremos de contactarle de inmediato y lo confirmaremos con usted en persona la próxima vez que le veamos, antes de borrar su expediente.',
  },
];

export const TEACH_BACK = [
  'What happens if we don’t see you for a while?',
  'Is this emergency help?',
  'How do you stop?',
];
