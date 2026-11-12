// The rehearsal runs against the local copy of production data and nothing else.
const url = process.env.REHEARSAL_DATABASE_URL || ''
if (!/^postgres(ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1):\d+\//.test(url)) {
  throw new Error('Refusing to run the rehearsal: REHEARSAL_DATABASE_URL must be a local database')
}
process.env.DATABASE_URL = url

// A module of its own (not a global script): keeps `url` out of the scope the other guard shares under tests/tsconfig.json
export {}
