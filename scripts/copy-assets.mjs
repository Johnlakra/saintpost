// tsc only emits .ts files; copy the SQL schema and saint data next to the compiled output.
import fs from 'fs';
fs.mkdirSync('dist/db', { recursive: true });
fs.mkdirSync('dist/data', { recursive: true });
fs.copyFileSync('src/db/schema.sql', 'dist/db/schema.sql');
fs.copyFileSync('src/data/saints.json', 'dist/data/saints.json');
