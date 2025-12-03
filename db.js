const mysql = require("mysql2");

const pool = mysql.createPool({
  host: process.env.DB_HOST_CLEVER,
  user: process.env.DB_USER_CLEVER,
  password: process.env.DB_PASSWORD_CLEVER,
  database: process.env.DB_NAME_CLEVER,
  port: process.env.DB_PORT_CLEVER || 3306,
  waitForConnections: true,
  connectionLimit: 5,  
  queueLimit: 0,
  ssl: {
    rejectUnauthorized: false
  }
});

// Probar conexión
pool.getConnection((err, conn) => {
  if (err) {
    console.error("❌ Error al conectar a MySQL:", err);
    return;
  }
  console.log("✅ Conexión establecida con MySQL (pool)");
  conn.release();
});

module.exports = pool;