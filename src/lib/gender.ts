/**
 * Gender of a creator: the values contract and a pure, offline inference
 * from the public name. Instagram/TikTok/Apify never provide gender, so the
 * only sources are a PM (genderSource 'manual') or this heuristic
 * (genderSource 'inferred').
 *
 * Values: 'F' (mujer) | 'M' (hombre) | 'X' (otro: pareja, familia, marca,
 * no binario) | null (sin dato). A null is always preferable to a wrong
 * guess: every ambiguity below resolves to null, and a PM can fix any row by
 * hand (PATCH /api/influencers/[id]/gender).
 *
 * No DB access, no network: safe to call anywhere (client bundles included).
 */

export type Gender = 'F' | 'M' | 'X'

export const GENDER_VALUES: readonly Gender[] = ['F', 'M', 'X'] as const

/** UI label (Spanish first; the EN side lives in translations.ts). */
export const GENDER_LABEL_ES: Record<Gender, string> = { F: 'Mujer', M: 'Hombre', X: 'Otro' }

export type GenderSource = 'manual' | 'inferred'

export function isValidGender(v: unknown): v is Gender {
  return v === 'F' || v === 'M' || v === 'X'
}

// ============ NAME LISTS ============
// Lowercase, accent-stripped (ñ → n). Most common Spanish/Latin first names
// plus their everyday short forms, and a modest set of unambiguous
// international names (the pool holds many foreign accounts).
//
// Deliberately in NEITHER list (they resolve to null): names used for both
// genders in Spain or abroad (alex, cris, dani, pau, toni/toñi, manu, fer,
// ale, sam, chus, jo, kim, andy, nicky, jean, joan, ariel, alexis, eli, noe,
// rene/renée, ali, lupe) and first names that are also everyday words or
// brand words (luz, paz, sol, mar, flor, coral, luna, vega, iris, estrella,
// alma, gala, ona, june, linda, german, roman, mark, nil, gil, vidal, justo,
// domingo, segundo, maximo, modesto, urbano, reyes).

const FEMALE_NAMES = [
  // Spain / Latin America
  'maria', 'carmen', 'ana', 'laura', 'marta', 'sara', 'lucia', 'paula', 'andrea', 'cristina', 'elena', 'patricia',
  'raquel', 'rocio', 'natalia', 'beatriz', 'alba', 'irene', 'claudia', 'nerea', 'marina', 'carla', 'noelia', 'silvia',
  'sandra', 'vanesa', 'vanessa', 'veronica', 'monica', 'esther', 'ester', 'pilar', 'rosa', 'isabel', 'eva', 'nuria',
  'lorena', 'alicia', 'sofia', 'julia', 'celia', 'ines', 'aitana', 'ainhoa', 'leire', 'idoia', 'nagore', 'miriam',
  'estefania', 'tamara', 'yolanda', 'susana', 'inmaculada', 'dolores', 'belen', 'angela', 'angeles',
  'angelica', 'antonia', 'francisca', 'josefa', 'josefina', 'manuela', 'daniela', 'daniella', 'danna', 'gabriela',
  'gabriella', 'alejandra', 'adriana', 'juana', 'juani', 'juanita', 'juliana', 'julieta', 'fernanda', 'valentina',
  'victoria', 'martina', 'carlota', 'ivana', 'mariona', 'ramona', 'roberta', 'simona', 'eugenia', 'luisa', 'teresa',
  'rosario', 'rosalia', 'rosana', 'rosaura', 'concepcion', 'encarnacion', 'amparo', 'montserrat', 'consuelo',
  'soledad', 'gloria', 'margarita', 'magdalena', 'catalina', 'carolina', 'lidia', 'olga', 'sonia', 'ruth', 'rebeca',
  'judith', 'judit', 'noemi', 'lara', 'vera', 'emma', 'olivia', 'valeria', 'chloe', 'cloe', 'gema', 'gemma', 'mireia',
  'ariadna', 'jimena', 'ximena', 'ainara', 'maite', 'mayte', 'amaia', 'naiara', 'nayara', 'uxue', 'izaro', 'irati',
  'garazi', 'maialen', 'oihane', 'nahia', 'naia', 'laia', 'aina', 'ane', 'meritxell', 'anna', 'alexandra', 'elisa',
  'elisabet', 'elisabeth', 'isabella', 'isa', 'leticia', 'lourdes', 'macarena', 'maribel', 'marisol', 'marisa',
  'mariana', 'marian', 'mariam', 'marilo', 'melisa', 'melissa', 'milagros', 'nadia', 'nieves', 'nora', 'norma',
  'paloma', 'penelope', 'rita', 'roxana', 'salome', 'selena', 'tania', 'tanya', 'trini', 'trinidad', 'guadalupe',
  'vicenta', 'violeta', 'virginia', 'yaiza', 'yasmina', 'yesenia', 'zaira', 'zoe', 'aroa', 'arancha', 'arantxa',
  'arantza', 'begona', 'blanca', 'candela', 'cayetana', 'covadonga', 'desiree', 'diana', 'edurne', 'elvira', 'emilia',
  'estela', 'fatima', 'florencia', 'genoveva', 'graciela', 'helena', 'inma', 'iria', 'itziar', 'jennifer', 'jenifer',
  'jessica', 'yessica', 'karina', 'karla', 'katia', 'katy', 'leonor', 'lia', 'liliana', 'lola', 'loli', 'lucero',
  'malena', 'manoli', 'marga', 'mari', 'maricarmen', 'marijose', 'mariluz', 'maya', 'merche', 'micaela', 'mila',
  'mimi', 'minerva', 'mireya', 'mirian', 'myriam', 'nancy', 'nines', 'noa', 'oriana', 'pamela', 'patri', 'pili',
  'piedad', 'priscila', 'purificacion', 'puri', 'remedios', 'reme', 'rosi', 'rosie', 'rose', 'ruby', 'sabrina',
  'samanta', 'samantha', 'sandy', 'sheila', 'silvana', 'soraya', 'susi', 'tatiana', 'tere', 'vero', 'vicky', 'viky',
  'yoli', 'zulema', 'anais', 'bea', 'cristi', 'estefi', 'lore', 'conchi', 'chelo', 'charo', 'mayka', 'maika', 'aida',
  'amalia', 'araceli', 'aurora', 'azucena', 'barbara', 'berta', 'brenda', 'camila', 'carmela', 'carina', 'casandra',
  'cecilia', 'cintia', 'cynthia', 'clara', 'constanza', 'dafne', 'dalia', 'debora', 'delia', 'denise', 'elisenda',
  'eloisa', 'erika', 'erica', 'esperanza', 'eulalia', 'fabiola', 'felisa', 'fiorella', 'gisela', 'greta', 'ingrid',
  'irina', 'ivonne', 'yvonne', 'jacqueline', 'jaqueline', 'jaclyn', 'janet', 'jazmin', 'jenny', 'jessy', 'johanna',
  'justina', 'karen', 'kiara', 'lais', 'lesly', 'leslie', 'lilian', 'lina', 'lisa', 'lissette', 'lizbeth', 'lucrecia',
  'luciana', 'ludmila', 'mabel', 'maider', 'marcela', 'marlene', 'matilde', 'maura', 'melany', 'melina', 'mia',
  'milena', 'miranda', 'mirta', 'nelly', 'nicole', 'nicol', 'nilda', 'ofelia', 'paola', 'paty', 'paulina', 'pia',
  'rafaela', 'renata', 'romina', 'rosalinda', 'rosmery', 'sarai', 'sarah', 'selene', 'serena', 'shirley', 'stefania',
  'stephanie', 'thais', 'tina', 'ursula', 'valery', 'valerie', 'vanina', 'wendy', 'wanda', 'xiomara', 'yanina',
  'yasmin', 'yenny', 'yudith', 'zoraida', 'davinia', 'arlene', 'elaine', 'alice',
  // International (unambiguous)
  'emily', 'hannah', 'amanda', 'michelle', 'rachel', 'kate', 'katie', 'kayla', 'megan', 'lauren', 'grace', 'lily',
  'ella', 'lucy', 'charlotte', 'amelia', 'ashley', 'brittany', 'heather', 'tiffany', 'kelly', 'susan', 'giulia',
  'francesca', 'chiara', 'alessia', 'giorgia', 'beatrice', 'federica', 'giovanna', 'joana', 'catarina', 'marie',
  'camille', 'lea', 'lucie', 'manon', 'juliette', 'julie', 'pauline', 'sophie', 'claire', 'sophia', 'mathilde',
  'gaelle', 'nathalie', 'natalie', 'nathalia', 'jenna', 'carly', 'sofi', 'amy', 'abby', 'abigail', 'alyssa', 'bella',
  'brooke', 'caitlin', 'chelsea', 'courtney', 'danielle', 'erin', 'gabrielle', 'holly', 'kaitlyn', 'kimberly',
  'kristen', 'kristina', 'leah', 'madison', 'natasha', 'paige', 'savannah', 'shannon', 'whitney', 'nina', 'lena',
  'ida', 'jade', 'kayleigh', 'martha', 'dora', 'alana', 'marion', 'alina', 'isabelle', 'josephine', 'frances',
  'francine', 'emmanuelle', 'marcia', 'colette', 'deanna', 'leonie', 'leona', 'nicoletta', 'anastasia', 'rossana',
  'rosanna', 'eleonora', 'lucille', 'paulette', 'alexa', 'alexia', 'angelina', 'antonella', 'evangelina',
  'antonina', 'joelle', 'erendira', 'jordina',
  // Diminutives (listed so they match exactly instead of through a prefix)
  'paulita', 'lolita', 'rosita', 'martita', 'sarita', 'saray', 'evita', 'teresita', 'conchita', 'pepita',
  'carmencita', 'isabelita', 'lucita', 'marcelina', 'joselyn', 'joselin', 'ivanna', 'jorgelina', 'teodora',
  'loreto', 'marisela', 'luisina', 'jane',
  // Turkish / Arabic / Indian (the pool holds many such accounts)
  'kubra', 'elif', 'zeynep', 'aisha', 'fatma', 'esra', 'ayse', 'merve', 'busra', 'hatice', 'emine', 'derya',
  'gamze', 'tugba', 'ozge', 'gizem', 'ebru', 'burcu', 'dilek', 'selin', 'ceren', 'melike', 'havva', 'sevgi',
  'bahar', 'amina', 'khadija', 'salma', 'yasmine', 'leila', 'layla', 'hajar', 'imane', 'ikram', 'meryem', 'zineb', 'houda',
  'hanane', 'rania', 'hiba', 'priya', 'pooja', 'neha', 'anjali', 'kavya', 'divya', 'sneha', 'riya', 'shreya',
  'ananya', 'nisha', 'sunita', 'anita', 'rumeysa',
] as const

const MALE_NAMES = [
  // Spain / Latin America
  'david', 'javier', 'javi', 'carlos', 'alejandro', 'daniel', 'pablo', 'sergio', 'sergi', 'jorge', 'alberto', 'miguel',
  'antonio', 'jose', 'juan', 'manuel', 'manolo', 'francisco', 'fran', 'paco', 'luis', 'raul', 'adrian', 'ivan', 'ruben',
  'diego', 'alvaro', 'marcos', 'marco', 'marc', 'mario', 'oscar', 'victor', 'fernando', 'nando', 'rafael', 'rafa', 'hugo',
  'martin', 'gonzalo', 'jaime', 'nicolas', 'nico', 'andres', 'cristian', 'christian', 'guillermo', 'roberto', 'rober',
  'angel', 'pedro', 'ismael', 'aitor', 'iker', 'unai', 'asier', 'jon', 'joseba', 'mikel', 'ander', 'eneko', 'gorka',
  'gaizka', 'julen', 'oier', 'xabier', 'xabi', 'markel', 'ibai', 'imanol', 'inaki', 'inigo', 'josu', 'koldo', 'patxi',
  'txema', 'pol', 'arnau', 'biel', 'oriol', 'roger', 'gerard', 'jordi', 'xavi', 'xavier', 'josep', 'pere', 'quim',
  'joaquim', 'ferran', 'bernat', 'ignacio', 'ignasi', 'nacho', 'santiago', 'santi', 'mateo', 'lucas', 'luca', 'leo',
  'leonardo', 'enzo', 'thiago', 'tiago', 'izan', 'eric', 'erik', 'erick', 'bruno', 'gabriel', 'samuel', 'samu',
  'ramon', 'ricardo', 'ricard', 'tomas', 'joaquin', 'emilio', 'eduardo', 'edu', 'enrique', 'quique', 'kike', 'felipe',
  'gregorio', 'agustin', 'arturo', 'cesar', 'esteban', 'eugenio', 'federico', 'felix', 'gerardo', 'hector', 'horacio',
  'humberto', 'isaac', 'isidro', 'jacobo', 'jaume', 'jeronimo', 'jesus', 'julian', 'julio', 'lorenzo', 'marcelo',
  'marcelino', 'mariano', 'mauricio', 'nestor', 'octavio', 'omar', 'orlando', 'pascual', 'patricio', 'rodrigo',
  'rogelio', 'salvador', 'salva', 'saul', 'sebastian', 'simon', 'teodoro', 'teo', 'valentin', 'vicente', 'alfonso',
  'alfredo', 'anselmo', 'aurelio', 'benito', 'benjamin', 'bartolome', 'bernardo', 'borja', 'braulio', 'camilo', 'ciro',
  'claudio', 'clemente', 'constantino', 'cristobal', 'damian', 'dario', 'dionisio', 'eloy', 'elias', 'emiliano',
  'ernesto', 'eusebio', 'evaristo', 'ezequiel', 'fabian', 'fabio', 'facundo', 'fermin', 'fidel', 'florentino', 'gaspar',
  'gustavo', 'heriberto', 'hernan', 'hilario', 'ildefonso', 'isaias', 'ivo', 'jacinto', 'jeremias', 'jonatan',
  'jonathan', 'jonas', 'josue', 'juanjo', 'juanma', 'juancar', 'juanlu', 'juanfran', 'lautaro', 'leandro', 'lisandro',
  'lucio', 'luciano', 'marcial', 'matias', 'maximiliano', 'melchor', 'moises', 'nicanor', 'noel', 'norberto',
  'oswaldo', 'pancho', 'pepe', 'pepo', 'quico', 'ramiro', 'raimundo', 'reinaldo', 'rodolfo', 'rolando', 'rosendo', 'ruy',
  'sabino', 'sandro', 'severino', 'silvio', 'ulises', 'valerio', 'venancio', 'victoriano', 'wenceslao', 'yago', 'yeray',
  'zacarias', 'abel', 'abraham', 'adan', 'adolfo', 'alan', 'aldo', 'amador', 'ambrosio', 'amancio', 'anibal',
  'aquilino', 'armando', 'arsenio', 'augusto', 'baltasar', 'basilio', 'blas', 'bonifacio', 'calixto', 'carmelo',
  'celestino', 'cipriano', 'cosme', 'cristofer', 'dimas', 'edgar', 'edwin', 'efrain', 'eladio', 'eleuterio', 'eliseo',
  'elvis', 'eustaquio', 'faustino', 'fausto', 'feliciano', 'gael', 'galo', 'genaro', 'gilberto', 'gines', 'guido',
  'hipolito', 'honorio', 'jairo', 'jeremy', 'joel', 'kevin', 'lazaro', 'lino', 'lope', 'macario', 'mauro', 'melquiades',
  'miquel', 'nazario', 'nemesio', 'nilo', 'olegario', 'onofre', 'otto', 'pelayo', 'policarpo', 'remigio', 'roque',
  'rufino', 'ruperto', 'sancho', 'serafin', 'severiano', 'sixto', 'tadeo', 'telmo', 'teofilo', 'tirso', 'tobias',
  'toribio', 'vladimir', 'walter', 'wilfredo', 'william', 'yoel', 'milton',
  // International (unambiguous)
  'michael', 'john', 'james', 'robert', 'richard', 'joseph', 'thomas', 'charles', 'christopher', 'matthew',
  'anthony', 'steven', 'steve', 'andrew', 'brian', 'jason', 'ryan', 'jacob', 'nick', 'tyler', 'brandon', 'justin',
  'adam', 'jack', 'henry', 'harry', 'george', 'oliver', 'liam', 'noah', 'ethan', 'logan', 'mason', 'peter', 'paul',
  'tom', 'ben', 'chris', 'mike', 'dave', 'tony', 'cody', 'giovanni', 'giuseppe', 'francesco', 'alessandro', 'matteo',
  'riccardo', 'davide', 'giorgio', 'stefano', 'joao', 'rui', 'nuno', 'goncalo', 'pierre', 'louis', 'antoine', 'julien',
  'maxime', 'mathieu', 'theo', 'raphael', 'arthur', 'patrick', 'doug', 'douglas', 'owen', 'connor', 'dylan', 'sean',
  'kyle', 'aaron', 'nathan', 'nathaniel', 'luke', 'josh', 'joshua', 'jake', 'max', 'austin', 'blake', 'brad',
  'bradley', 'caleb', 'carter', 'cole', 'colin', 'craig', 'dean', 'derek', 'dominic', 'drew', 'dustin', 'edward',
  'evan', 'frank', 'gavin', 'grant', 'greg', 'gregory', 'hunter', 'ian', 'isaiah', 'jared', 'jeff', 'jeffrey', 'jim',
  'jimmy', 'joe', 'joey', 'keith', 'ken', 'kenneth', 'levi', 'marcus', 'neil', 'phil', 'philip', 'ralph', 'rick',
  'rob', 'ronald', 'russell', 'scott', 'seth', 'shane', 'shawn', 'spencer', 'stuart', 'tim', 'timothy',
  'todd', 'travis', 'trevor', 'troy', 'vincent', 'wayne', 'wesley', 'zach', 'zachary', 'emmanuel', 'milan',
  'jaden', 'jayden', 'marcel', 'paulo', 'adriano', 'adrien', 'carlo', 'angelo', 'anton', 'alexander', 'alexandre',
  'cristiano', 'andre', 'andreu', 'laurent', 'marino', 'silvestre', 'peppe', 'nicolo', 'leonard',
  // Diminutives
  'danielito', 'carlitos', 'pablito', 'pedrito', 'miguelito', 'luisito', 'manolito', 'juanito',
  // Turkish / Arabic / Indian (the pool holds many such accounts)
  'mehmet', 'ahmed', 'ahmet', 'mohamed', 'mohammed', 'muhammad', 'mustafa', 'huseyin', 'hasan', 'hassan', 'ibrahim',
  'ismail', 'yusuf', 'youssef', 'murat', 'emre', 'burak', 'serkan', 'kemal', 'osman', 'omer', 'halil', 'furkan',
  'enes', 'ugur', 'volkan', 'eren', 'onur', 'tolga', 'hakan', 'selim', 'recep', 'ramazan', 'bilal', 'yasin', 'kadir',
  'metin', 'erdem', 'sinan', 'kaan', 'berk', 'umut', 'abdullah', 'hussein', 'khalid', 'karim', 'tarek', 'rachid',
  'hamza', 'ayoub', 'adil', 'nabil', 'samir', 'walid', 'yassine', 'anil', 'rahul', 'amit', 'rohit', 'vikram',
  'arjun', 'sanjay', 'suresh', 'ramesh', 'manoj', 'ravi', 'ajay', 'vijay', 'deepak', 'sunil',
] as const

/**
 * Gendered Spanish/English role words and adjectives (any position in the
 * name): "Gema | creadora UGC", "Mamá de dos", "La Vecina Rubia". Bare
 * titles (sr/sra, dr/dra, mr/mrs/miss) are NOT evidence: "Vileda ČR a SR"
 * and "Mr Holden Parts Shop" are not people. They live in STOP_WORDS only.
 */
const FEMALE_ROLE_WORDS = [
  'mama', 'mami', 'mamita', 'mamma', 'maman', 'mamae', 'madre', 'mother', 'mom', 'mum', 'mummy', 'mommy', 'creadora',
  'chica', 'mujer', 'senora', 'senorita', 'doctora', 'enfermera', 'entrenadora', 'fotografa',
  'disenadora', 'maquilladora', 'peluquera', 'cocinera', 'abogada', 'arquitecta', 'psicologa', 'profesora', 'maestra',
  'emprendedora', 'viajera', 'bloguera', 'actriz', 'bailarina', 'escritora', 'ilustradora', 'farmaceutica', 'medica',
  'ingeniera', 'esposa', 'abuela', 'tia', 'hija', 'rubia', 'morena', 'pelirroja', 'guapa', 'girl', 'woman', 'lady',
  'wife', 'sister', 'hermana', 'she', 'her', 'coqueta', 'embarazada', 'novia', 'bride',
] as const

const MALE_ROLE_WORDS = [
  'papa', 'papi', 'papito', 'padre', 'father', 'dad', 'daddy', 'creador', 'chico', 'hombre', 'senor', 'doctor',
  'enfermero', 'entrenador', 'fotografo', 'disenador', 'maquillador', 'peluquero', 'cocinero', 'abogado', 'arquitecto',
  'psicologo', 'profesor', 'maestro', 'emprendedor', 'viajero', 'bloguero', 'actor', 'bailarin', 'escritor',
  'ilustrador', 'farmaceutico', 'medico', 'ingeniero', 'esposo', 'abuelo', 'tio', 'hijo', 'rubio', 'moreno',
  'pelirrojo', 'guapo', 'boy', 'man', 'gentleman', 'mister', 'husband', 'brother', 'hermano', 'barbero', 'barber',
  'novio', 'groom',
] as const

/**
 * Words that denote a couple, a family or a group: the account is not one
 * person → 'X'. Checked after the person-name match (a mother who signs
 * "Marta | mamá de dos" stays 'F').
 */
const COLLECTIVE_WORDS = [
  'familia', 'family', 'fam', 'pareja', 'parejas', 'couple', 'couples', 'padres', 'papas', 'papis', 'mamas', 'mamis',
  'parents', 'hermanos', 'hermanas', 'brothers', 'sisters', 'siblings', 'gemelos', 'gemelas', 'mellizos', 'mellizas',
  'twins', 'trillizos', 'trillizas', 'amigas', 'amigos', 'friends', 'creadores',
  'creadoras', 'viajeros', 'viajeras', 'travelers', 'travellers', 'nosotros', 'nosotras', 'duo', 'trio', 'team',
  'equipo', 'squad', 'crew', 'tribu', 'tribe', 'clan', 'casados', 'esposos', 'matrimonio', 'novios', 'newlyweds',
] as const

/**
 * Words that clearly denote a brand, shop, institution or media outlet → 'X'.
 * Niche and content-type words (home, deco, hogar, tips, recetas, reviews,
 * tech, "marca personal"…) are NOT here: "Jenna | From House To Home DIY" or
 * "Recetas de Marta" are still one person — they stay null unless a name or
 * a role word decides.
 */
const BRAND_WORDS = [
  'shop', 'tienda', 'store', 'outlet', 'studio', 'estudio', 'studios',
  'oficial', 'official', 'grupo', 'group', 'club', 'agencia', 'agency', 'academy', 'academia', 'tv', 'podcast',
  'magazine', 'revista', 'news', 'noticias', 'media', 'medios', 'company', 'empresa', 'corp', 'inc',
  'ltd', 'restaurante', 'restaurant', 'bar', 'cafe', 'cafeteria', 'hotel', 'clinica', 'clinic', 'gym', 'gimnasio',
  'boutique', 'market', 'mercado', 'supermercado', 'farmacia', 'pharmacy', 'electronics', 'electronica', 'informatica',
  'ofertas', 'chollos', 'descuentos', 'productos', 'products', 'servicios', 'services', 'seleccion', 'federacion',
  'asociacion', 'fundacion', 'ayuntamiento', 'universidad', 'colegio', 'escuela', 'school', 'instituto', 'radio',
  'editorial', 'oficina', 'comunidad', 'community', 'fanpage', 'fanclub', 'memes', 'frases', 'humor',
] as const

/**
 * Tokens skipped when looking for the first meaningful word of a segment
 * ("Dra. Laura", "Soy Marta", "The Real Pablo", "By Ana"). Titles (dr/dra,
 * sr/sra, mr/mrs/miss) are skipped so the name that follows decides; the
 * full words doctor/doctora, señor/señora also count as role words.
 */
const STOP_WORDS = new Set([
  'the', 'by', 'soy', 'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'lic', 'prof', 'ing', 'coach', 'real', 'its',
  'im', 'hola', 'hi', 'hey', 'con', 'por', 'para', 'with', 'mi', 'tu', 'su', 'me', 'yo', 'i', 'am', 'this', 'is', 'esta',
  'este', 'aqui', 'here', 'official', 'oficial', 'new', 'nuevo', 'nueva', 'mundo', 'world', 'life', 'vida', 'ugc',
  'creator', 'content', 'contenido', 'influencer', 'blogger', 'youtuber', 'tiktoker', 'instagramer', 'instagrammer',
  'dr', 'dra', 'doctor', 'doctora', 'sr', 'sra', 'srta', 'senor', 'senora', 'senorita', 'mr', 'mrs', 'miss', 'ms',
  'don', 'dona',
])

/** Connectors that join two people into a couple ("Ana y Pedro", "Marta & Carlos", "Laura and Tom"). */
const COUPLE_CONNECTORS = new Set(['y', 'e', 'and', 'et', 'und'])

const FEMALE = new Set<string>(FEMALE_NAMES)
const MALE = new Set<string>(MALE_NAMES)
// A name that slipped into both lists is ambiguous → removed from both.
for (const n of Array.from(FEMALE)) {
  if (MALE.has(n)) {
    FEMALE.delete(n)
    MALE.delete(n)
  }
}
const FEMALE_ROLE = new Set<string>(FEMALE_ROLE_WORDS)
const MALE_ROLE = new Set<string>(MALE_ROLE_WORDS)
const COLLECTIVE = new Set<string>(COLLECTIVE_WORDS)
const BRAND = new Set<string>(BRAND_WORDS)

/**
 * Handle stems that start with a listed name but are surnames or words:
 * "hernandezautosales" must not become hernan, "martinezfamily" martin,
 * "lopez" lope, "perez" pere, "rosales" rosa, "maximum" max…
 */
const PREFIX_BLOCK = ['martinez', 'hernandez', 'lopez', 'perez', 'rosales', 'rosas', 'rosado', 'rubio', 'maxim', 'leon', 'alonso']

/**
 * Prefix matching on a concatenated run ("martalagopoza" → marta) needs this
 * many letters: names of 3-4 letters (ana, eva, jon, joel, quim, adan, eren…)
 * only match exactly, so "joelleghannam" is not joel and "erendira" not eren.
 */
const MIN_PREFIX_LEN = 5
/** Longest name in the lists. */
const MAX_PREFIX_LEN = 12

// ============ NORMALIZATION ============

/**
 * Small-capital letters ("ᴘɪʟᴀʀ ᴀɴɪᴍᴀᴄɪᴏɴ", "ʙᴇʀᴛᴀ ᴄᴏʟᴍᴇɴᴇʀᴏ"), a common
 * Instagram font, have no NFKC mapping; folded by hand.
 */
const SMALL_CAPS: Record<string, string> = {
  'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i', 'ᴊ': 'j', 'ᴋ': 'k',
  'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ʀ': 'r', 'ꜱ': 's', 'ᴛ': 't', 'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w',
  'ʏ': 'y', 'ᴢ': 'z',
}
const SMALL_CAPS_RE = /[ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘʀꜱᴛᴜᴠᴡʏᴢ]/g

/**
 * NFKC folds decorative Unicode letters ("𝓢𝓪𝓻𝓪", "ℳℰ𝒳ℐ𝒞𝒪", fullwidth) into
 * plain ASCII; NFD + mark removal strips accents (é → e, ñ → n). Emoji,
 * punctuation and digits become separators; '&' / '+' become ' y '. Segment
 * separators (| / • · : , - – — brackets) are kept for segmentTokens.
 */
export function normalizeNameText(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(SMALL_CAPS_RE, ch => SMALL_CAPS[ch] ?? ch)
    .replace(/[&+]/g, ' y ')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z\s|/•·:,()[\]{}\-–—]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "C e c i l i a" / "B E L L A 🧸": a run of ≥ 3 spaced single letters is one word written letter by letter. */
function joinSpacedLetters(tokens: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < tokens.length;) {
    let j = i
    while (j < tokens.length && tokens[j].length === 1) j++
    if (j - i >= 3) {
      out.push(tokens.slice(i, j).join(''))
      i = j
    } else {
      out.push(tokens[i])
      i++
    }
  }
  return out
}

/** Segments ("Gema | creadora UGC | Valencia" → 3) and the alphabetic tokens of each. */
function segmentTokens(normalized: string): string[][] {
  return normalized
    .split(/[|/•·:,()[\]{}\-–—]+/)
    .map(seg => joinSpacedLetters(seg.split(/[^a-z]+/).filter(Boolean)))
    .filter(seg => seg.length > 0)
}

function nameGender(token: string): Gender | 'ambiguous' | null {
  const f = FEMALE.has(token)
  const m = MALE.has(token)
  if (f && m) return 'ambiguous'
  if (f) return 'F'
  if (m) return 'M'
  return null
}

function roleGender(token: string): Gender | null {
  if (FEMALE_ROLE.has(token)) return 'F'
  if (MALE_ROLE.has(token)) return 'M'
  return null
}

/** A token that stands for a person (first name or gendered role word). */
function personGender(token: string): Gender | 'ambiguous' | null {
  return nameGender(token) ?? roleGender(token)
}

/**
 * Longest name (≥ MIN_PREFIX_LEN letters) that `run` starts with, across
 * both lists; null when none or when the best female and male candidates tie.
 * Length decides collisions: "juana…" → F over "juan", "cristian…" → M over
 * "cristi", "mariano…" → M over "maria".
 */
function prefixGender(run: string): Gender | null {
  if (run.length < MIN_PREFIX_LEN) return null
  if (PREFIX_BLOCK.some(stem => run.startsWith(stem))) return null
  let bestF = 0
  let bestM = 0
  for (let len = Math.min(run.length, MAX_PREFIX_LEN); len >= MIN_PREFIX_LEN; len--) {
    const candidate = run.slice(0, len)
    if (!bestF && FEMALE.has(candidate)) bestF = len
    if (!bestM && MALE.has(candidate)) bestM = len
    if (bestF && bestM) break
  }
  if (bestF === bestM) return null
  return bestF > bestM ? 'F' : 'M'
}

/** Leading alphabetic run of a handle: "@_marta.lago_99" → "marta"; "user9786" → "user". */
function leadingAlphaRun(username: string | null | undefined): string {
  const normalized = normalizeNameText((username ?? '').replace(/^@+/, ''))
  const match = normalized.replace(/^[^a-z]+/, '').match(/^[a-z]+/)
  return match ? match[0] : ''
}

/** Exact person match on a run, then the longest-prefix name match. */
function runGender(run: string): Gender | 'ambiguous' | null {
  const exact = personGender(run)
  if (exact) return exact
  return prefixGender(run)
}

/**
 * Collective markers inside a handle ("@alqahtanifamily", "@familia.perez",
 * "@the_twins_"): a handle like that names a family or a couple even when the
 * display name reads as one person ("Ahmed & Shory"). Substrings long enough
 * to be unambiguous only: 'fam', 'duo', 'team', 'crew'… are deliberately
 * absent (famous, teamwork, screw…).
 */
const HANDLE_GROUP_STEMS = [
  'family', 'familia', 'familie', 'pareja', 'couple', 'twins', 'gemelos', 'gemelas', 'mellizos', 'mellizas',
  'hermanos', 'hermanas', 'brothers', 'sisters', 'siblings', 'matrimonio', 'newlyweds', 'parents',
] as const

function handleDenotesGroup(username: string | null | undefined): boolean {
  const letters = normalizeNameText((username ?? '').replace(/^@+/, '')).replace(/[^a-z]/g, '')
  return letters.length > 0 && HANDLE_GROUP_STEMS.some(stem => letters.includes(stem))
}

// ============ INFERENCE ============

/**
 * Infers the gender of a creator from its public display name and, only when
 * that name has no letters at all, from its handle. Rules, first hit wins:
 *
 *  1. couple/family pattern "<person> y|and|& <person|collective>" → 'X'
 *     ("Ana y Pedro", "David y familia"); "<person> & <someone>" counts
 *     too when the handle says family/couple ("Ahmed & Shory" @…family)
 *  2. first meaningful token of each segment of the display name is a first
 *     name or a gendered role word ("Maestra Paloma", "Mamá de dos")
 *     → 'F' | 'M' (a name in both lists marks the row ambiguous)
 *  3. a collective word (familia, pareja, hermanas, team…) anywhere → 'X'
 *  4. a gendered role word anywhere (creadora/creador, mamá/papá, dra…)
 *     → 'F' | 'M'; both genders present → null
 *  5. a brand/shop/media word anywhere in the display name → 'X'
 *     ("Metinler Yapı Market", "Dantona group")
 *  6. leading alphabetic run of a single-token display name ("martalagopoza"
 *     → F) or, when the display name has no letters in any script (blank,
 *     emoji only), of the handle: exact name/role match, then longest
 *     ≥ 5-letter name prefix
 *  7. null (sin dato). An ambiguous first name (alex, cris…) stops at 4.
 *
 * A handle is never read as a person's name while a display name exists,
 * Latin or not: it is often another person's or a shop's name ("RUMEYSA
 * DENİZ" @ugur.…, "Antonina Zych" @antoninazych would have read as anton).
 * The one thing a handle can add is a collective marker (@alqahtanifamily,
 * @familia.perez): it confirms the couple in rule 1 and decides 'X' at rule 6
 * when the display name identified nobody. A clear single first name or role
 * word in the display name still wins ("Rebeca ~ UGC" @bekyandfamily → F).
 *
 * Pure and deterministic; never throws.
 */
export function inferGenderFromName(displayName: string | null | undefined, username?: string | null): Gender | null {
  const normalized = normalizeNameText(displayName)
  const segments = segmentTokens(normalized)
  const allTokens = segments.flat()
  const handleCollective = handleDenotesGroup(username)
  let ambiguous = false

  if (allTokens.length > 0) {
    // 1. Couple / family: "<person> y <person>" or "<person> y <collective>" anywhere in the token stream, and
    //    "<person> y <someone unknown>" when the handle itself says family/couple ("Ahmed & Shory" @alqahtanifamily).
    for (let i = 1; i + 1 < allTokens.length; i++) {
      if (!COUPLE_CONNECTORS.has(allTokens[i])) continue
      const left = allTokens[i - 1]
      const right = allTokens[i + 1]
      const leftPerson = personGender(left) !== null
      const rightPerson = personGender(right) !== null
      if ((leftPerson && (rightPerson || COLLECTIVE.has(right))) || (rightPerson && COLLECTIVE.has(left))) return 'X'
      if (handleCollective && (leftPerson || rightPerson) && !STOP_WORDS.has(left) && !STOP_WORDS.has(right)) return 'X'
    }

    // 2. First meaningful token of each segment: a first name or a role word ("Maestra Paloma").
    for (const seg of segments) {
      const token = seg.find(t => !STOP_WORDS.has(t))
      if (!token) continue
      const g = personGender(token)
      if (g === 'ambiguous') {
        ambiguous = true
        continue
      }
      if (g) return g
    }

    // 3. Collective words → X.
    if (allTokens.some(t => COLLECTIVE.has(t))) return 'X'

    // 4. Gendered role words anywhere.
    let roleF = false
    let roleM = false
    for (const t of allTokens) {
      const g = roleGender(t)
      if (g === 'F') roleF = true
      if (g === 'M') roleM = true
    }
    if (roleF !== roleM) return roleF ? 'F' : 'M'
    if (roleF && roleM) return null

    // A person's name was seen but is used for both genders: nothing below can beat that.
    if (ambiguous) return null

    // 5. Brand words → X (before any run heuristic: a shop's handle must not turn it into a person).
    if (allTokens.some(t => BRAND.has(t))) return 'X'
  }

  // 6. Leading alphabetic run: a single concatenated display token, or the handle when the display name has no
  //    letters at all (a Cyrillic/Arabic/CJK name is a name we cannot read, not a missing one).
  if (handleCollective) return 'X'
  const hasLetters = /\p{L}/u.test(displayName ?? '')
  const run = allTokens.length === 1 ? allTokens[0] : allTokens.length === 0 && !hasLetters ? leadingAlphaRun(username) : ''
  if (run) {
    const g = runGender(run)
    if (g === 'ambiguous') return null
    if (g) return g
  }

  return null
}
