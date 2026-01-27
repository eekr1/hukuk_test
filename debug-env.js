
import dotenv from "dotenv";
dotenv.config();

console.log("DATABASE_URL:", process.env.DATABASE_URL);
console.log("PORT:", process.env.PORT);
console.log("PWD:", process.cwd());
import fs from 'fs';
try {
    const envFile = fs.readFileSync('.env', 'utf8');
    console.log(".env content length:", envFile.length);
} catch (e) {
    console.log(".env read error:", e.message);
}
