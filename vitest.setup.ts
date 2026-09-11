import fs from 'fs'
import path from 'path'

const envPath = path.resolve(process.cwd(), '.env')
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8')
  envContent.split('\n').forEach(line => {
    const [key, ...rest] = line.split('=')
    if (key && key.trim()) {
      process.env[key.trim()] = rest.join('=').trim()
    }
  })
}
