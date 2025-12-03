const express = require('express');
const path = require('path');
const session = require('express-session');
const db = require('./db');
const PDFDocument = require('pdfkit');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    secret: 'mi_clave_super_secreta_para_el_carrito', 
    resave: false,
    saveUninitialized: true,
  })
);

app.use((req, res, next) => {
  if (!req.session.cart) {
    req.session.cart = []; 
  }
  next();
});

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.cartCount = req.session.cart
    ? req.session.cart.reduce((sum, item) => sum + item.cantidad, 0)
    : 0;
  next();
});

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/productos?loginError=Debes iniciar sesión para continuar.');
  }
  next();
}

function calcularTotal(cart) {
  return cart.reduce((sum, item) => sum + item.precio * item.cantidad, 0);
}

app.get('/productos', (req, res) => {
  const { loginError, registroError } = req.query; 
  const sql = 'SELECT * FROM productos';

  db.query(sql, (err, results) => {
    if (err) {
      console.error('Error al obtener productos:', err);
      return res.status(500).send('Error al obtener productos');
    }

    res.render('productos', {
      productos: results,
      loginError,
      registroError,
    });
  });
});

app.post('/carrito/agregar', (req, res) => {
  const { productoId } = req.body;

  const sql = 'SELECT * FROM productos WHERE id = ?';
  db.query(sql, [productoId], (err, results) => {
    if (err) {
      console.error('Error al buscar producto:', err);
      return res.status(500).send('Error al agregar al carrito');
    }

    if (results.length === 0) {
      return res.status(404).send('Producto no encontrado');
    }

    const producto = results[0];
    const cart = req.session.cart;
    const existing = cart.find((item) => item.producto_id === producto.id);

    if (existing) {
      existing.cantidad += 1;
    } else {
      cart.push({
        producto_id: producto.id,
        nombre: producto.nombre,
        precio: Number(producto.precio),
        cantidad: 1,
      });
    }

    req.session.cart = cart;
    res.redirect('/productos');
  });
});

app.get('/carrito', (req, res) => {
  const cart = req.session.cart;
  const total = calcularTotal(cart);

  res.render('carrito', {
    cart,
    total,
  });
});

app.post('/carrito/actualizar', (req, res) => {
  const { productoId, cantidad } = req.body;
  const qty = parseInt(cantidad, 10);

  if (qty <= 0) {
    return res.redirect('/carrito');
  }

  const cart = req.session.cart;
  const item = cart.find((i) => i.producto_id == productoId);

  if (item) {
    item.cantidad = qty;
  }

  req.session.cart = cart;
  res.redirect('/carrito');
});

app.post('/carrito/eliminar', (req, res) => {
  const { productoId } = req.body;

  const cart = req.session.cart;
  const nuevoCarrito = cart.filter((i) => i.producto_id != productoId);

  req.session.cart = nuevoCarrito;
  res.redirect('/carrito');
});

app.post('/registro', (req, res) => {
  const { nombre, email, password } = req.body;

  if (!nombre || !email || !password) {
    return res.redirect('/productos?registroError=Completa todos los campos.');
  }

  const checkSql = 'SELECT * FROM usuarios WHERE email = ?';
  db.query(checkSql, [email], (err, results) => {
    if (err) {
      console.error('Error al verificar email:', err);
      return res.redirect('/productos?registroError=Error en el servidor.');
    }

    if (results.length > 0) {
      return res.redirect('/productos?registroError=El correo ya está registrado.');
    }

    const insertSql = 'INSERT INTO usuarios (nombre, email, password) VALUES (?, ?, ?)';
    db.query(insertSql, [nombre, email, password], (err2, result) => {
      if (err2) {
        console.error('Error al registrar usuario:', err2);
        return res.redirect('/productos?registroError=No se pudo registrar.');
      }

      req.session.user = {
        id: result.insertId,
        nombre,
        email,
      };

      res.redirect('/productos');
    });
  });
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;

  const sql = 'SELECT * FROM usuarios WHERE email = ?';
  db.query(sql, [email], (err, results) => {
    if (err) {
      console.error('Error al buscar usuario:', err);
      return res.redirect('/productos?loginError=Error en el servidor.');
    }

    if (results.length === 0) {
      return res.redirect('/productos?loginError=Correo o contraseña incorrectos.');
    }

    const user = results[0];

    if (user.password !== password) {
      return res.redirect('/productos?loginError=Correo o contraseña incorrectos.');
    }

    req.session.user = {
      id: user.id,
      nombre: user.nombre,
      email: user.email,
    };

    res.redirect('/productos');
  });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/productos');
  });
});

app.get('/checkout', requireLogin, (req, res) => {
  const cart = req.session.cart || [];

  if (!cart.length) {
    return res.redirect('/carrito');
  }

  const total = calcularTotal(cart);

  res.render('checkout', {
    cart,
    total,
  });
});

app.post('/checkout', requireLogin, (req, res) => {
  const cart = req.session.cart || [];

  if (!cart.length) {
    return res.redirect('/carrito');
  }

  const total = calcularTotal(cart);
  const userId = req.session.user.id;

  const insertOrdenSql = 'INSERT INTO ordenes (usuario_id, total) VALUES (?, ?)';

  db.query(insertOrdenSql, [userId, total], (err, result) => {
    if (err) {
      console.error('Error al crear orden:', err);
      return res.status(500).send('Error al crear la orden.');
    }

    const ordenId = result.insertId;

    const insertDetalleSql = `
      INSERT INTO orden_detalle (orden_id, producto_id, cantidad, precio_unitario, subtotal)
      VALUES (?, ?, ?, ?, ?)
    `;

    let pendientes = cart.length;
    for (const item of cart) {
      const subtotal = item.precio * item.cantidad;
      db.query(
        insertDetalleSql,
        [ordenId, item.producto_id, item.cantidad, item.precio, subtotal],
        (err2) => {
          if (err2) {
            console.error('Error al insertar detalle de orden:', err2);
          }
          pendientes--;
          if (pendientes === 0) {
            req.session.cart = [];
            res.redirect(`/historial?ordenExitosa=1`);
          }
        }
      );
    }
  });
});

// ✅ RUTA HISTORIAL CORREGIDA
app.get('/historial', requireLogin, (req, res) => {
  const userId = req.session.user.id;

  const ordenesSql = `
    SELECT id, total, fecha_orden
    FROM ordenes
    WHERE usuario_id = ?
    ORDER BY fecha_orden DESC
  `;

  db.query(ordenesSql, [userId], (err, ordenes) => {
    if (err) {
      console.error('Error al obtener historial:', err);
      return res.status(500).send('Error al obtener historial.');
    }

    if (ordenes.length === 0) {
      // ✅ CORRECCIÓN: Agregada variable ordenExitosa
      return res.render('historial', {
        ordenes: [],
        detallesPorOrden: {},
        ordenExitosa: req.query.ordenExitosa === '1'  // 👈 ESTA ES LA CORRECCIÓN
      });
    }

    const ordenIds = ordenes.map(o => o.id);

    const detalleSql = `
      SELECT od.orden_id, od.cantidad, od.precio_unitario, od.subtotal,
             p.nombre AS producto_nombre
      FROM orden_detalle od
      JOIN productos p ON p.id = od.producto_id
      WHERE od.orden_id IN (?)
    `;

    db.query(detalleSql, [ordenIds], (err2, detalles) => {
      if (err2) {
        console.error('Error al obtener detalles:', err2);
        return res.status(500).send('Error al obtener detalles.');
      }

      const detallesPorOrden = {};
      for (const d of detalles) {
        if (!detallesPorOrden[d.orden_id]) {
          detallesPorOrden[d.orden_id] = [];
        }
        detallesPorOrden[d.orden_id].push(d);
      }

      // ✅ CORRECCIÓN: Agregada variable ordenExitosa
      res.render('historial', {
        ordenes,
        detallesPorOrden,
        ordenExitosa: req.query.ordenExitosa === '1'  // 👈 ESTA ES LA CORRECCIÓN
      });
    });
  });
});

// ✅ TICKET PDF MEJORADO - Genera un ticket profesional
app.get('/ticket/:ordenId', requireLogin, (req, res) => {
  const userId = req.session.user.id;
  const ordenId = req.params.ordenId;

  const ordenSql = `
    SELECT o.id, o.usuario_id, o.total, o.fecha_orden, u.nombre, u.email
    FROM ordenes o
    INNER JOIN usuarios u ON o.usuario_id = u.id
    WHERE o.id = ? AND o.usuario_id = ?
  `;

  db.query(ordenSql, [ordenId, userId], (err, ordenes) => {
    if (err) {
      console.error('Error al obtener orden:', err);
      return res.status(500).send('Error al obtener orden.');
    }

    if (ordenes.length === 0) {
      return res.status(404).send('Orden no encontrada.');
    }

    const orden = ordenes[0];

    const detalleSql = `
      SELECT od.cantidad, od.precio_unitario, od.subtotal,
             p.nombre AS producto_nombre, p.descripcion
      FROM orden_detalle od
      JOIN productos p ON p.id = od.producto_id
      WHERE od.orden_id = ?
    `;

    db.query(detalleSql, [ordenId], (err2, detalles) => {
      if (err2) {
        console.error('Error al obtener detalles:', err2);
        return res.status(500).send('Error al obtener detalles.');
      }

      // ===== GENERAR PDF PROFESIONAL =====
      const doc = new PDFDocument({ 
        size: 'LETTER',
        margins: { top: 50, bottom: 50, left: 50, right: 50 }
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="ticket_${ordenId}.pdf"`);

      doc.pipe(res);

      // ENCABEZADO
      doc.fontSize(24).font('Helvetica-Bold').text('TechStore', { align: 'center' });
      doc.fontSize(10).font('Helvetica').text('Tienda en línea de tecnología', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(9).text('www.techstore.com | contacto@techstore.com', { align: 'center' });
      doc.moveDown(1);

      // Línea separadora
      doc.strokeColor('#333333').lineWidth(2);
      doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke();
      doc.moveDown(1);

      // TÍTULO DEL TICKET
      doc.fontSize(18).font('Helvetica-Bold').text('TICKET DE COMPRA', { align: 'center' });
      doc.moveDown(1);

      // Información de la orden
      const fechaOrden = new Date(orden.fecha_orden);
      const fechaFormateada = fechaOrden.toLocaleDateString('es-MX', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      doc.fontSize(11).font('Helvetica');
      doc.text(`Número de Orden: #${orden.id}`, 50, doc.y);
      doc.text(`Fecha: ${fechaFormateada}`, 50, doc.y);
      doc.text(`Cliente: ${orden.nombre}`, 50, doc.y);
      doc.text(`Email: ${orden.email}`, 50, doc.y);
      doc.moveDown(1.5);

      // Línea separadora
      doc.strokeColor('#cccccc').lineWidth(1);
      doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke();
      doc.moveDown(1);

      // TABLA DE PRODUCTOS
      doc.fontSize(12).font('Helvetica-Bold').text('PRODUCTOS COMPRADOS', { align: 'center' });
      doc.moveDown(0.8);

      // Encabezados de tabla
      const tableTop = doc.y;
      const col1 = 50;   // Producto
      const col2 = 300;  // Cantidad
      const col3 = 380;  // Precio Unit.
      const col4 = 480;  // Subtotal

      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Producto', col1, tableTop);
      doc.text('Cant.', col2, tableTop);
      doc.text('Precio', col3, tableTop);
      doc.text('Subtotal', col4, tableTop);
      
      // Línea debajo de encabezados
      doc.moveTo(50, tableTop + 15).lineTo(562, tableTop + 15).stroke();

      let yPosition = tableTop + 25;
      doc.font('Helvetica').fontSize(9);

      // Listar productos
      detalles.forEach(det => {
        // Verificar si necesitamos una nueva página
        if (yPosition > 700) {
          doc.addPage();
          yPosition = 50;
        }

        const precioUnit = Number(det.precio_unitario || 0);
        const subtotal = Number(det.subtotal || 0);

        doc.text(det.producto_nombre, col1, yPosition, { width: 240 });
        doc.text(det.cantidad.toString(), col2, yPosition);
        doc.text(`$${precioUnit.toFixed(2)}`, col3, yPosition);
        doc.text(`$${subtotal.toFixed(2)}`, col4, yPosition);

        yPosition += 20;
      });

      // Línea antes del total
      doc.strokeColor('#cccccc').lineWidth(1);
      doc.moveTo(50, yPosition + 5).lineTo(562, yPosition + 5).stroke();
      doc.moveDown(1);

      // TOTAL
      yPosition += 20;
      const totalNumero = Number(orden.total || 0);
      
      doc.fontSize(14).font('Helvetica-Bold');
      doc.text('TOTAL:', 380, yPosition);
      doc.text(`$${totalNumero.toFixed(2)}`, 480, yPosition);

      // PIE DE PÁGINA
      doc.fontSize(8).font('Helvetica').fillColor('#666666');
      doc.text('¡Gracias por tu compra!', 50, 720, { align: 'center' });
      doc.text('Este ticket es válido como comprobante de compra', 50, 735, { align: 'center' });
      doc.text('Para soporte técnico contacta: soporte@techstore.com', 50, 750, { align: 'center' });

      doc.end();
    });
  });
});

// ✅ NUEVO: REPORTE COMPLETO EN PDF
app.get('/reporte-completo-pdf', requireLogin, (req, res) => {
  const userId = req.session.user.id;

  const ordenesSql = `
    SELECT o.id, o.total, o.fecha_orden
    FROM ordenes o
    WHERE o.usuario_id = ?
    ORDER BY o.fecha_orden DESC
  `;

  db.query(ordenesSql, [userId], (err, ordenes) => {
    if (err) {
      console.error('Error al obtener órdenes:', err);
      return res.status(500).send('Error al generar el reporte');
    }

    if (ordenes.length === 0) {
      return res.status(404).send('No tienes compras registradas');
    }

    const ordenIds = ordenes.map(o => o.id);

    const detalleSql = `
      SELECT 
        od.orden_id,
        od.cantidad,
        od.precio_unitario,
        od.subtotal,
        p.nombre AS producto_nombre
      FROM orden_detalle od
      INNER JOIN productos p ON p.id = od.producto_id
      WHERE od.orden_id IN (?)
    `;

    db.query(detalleSql, [ordenIds], (err2, detalles) => {
      if (err2) {
        console.error('Error al obtener detalles:', err2);
        return res.status(500).send('Error al generar el reporte');
      }

      // Organizar detalles por orden
      const detallesPorOrden = {};
      detalles.forEach(det => {
        if (!detallesPorOrden[det.orden_id]) {
          detallesPorOrden[det.orden_id] = [];
        }
        detallesPorOrden[det.orden_id].push(det);
      });

      // ===== GENERAR PDF =====
      const doc = new PDFDocument({ margin: 50 });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename=historial-completo.pdf');

      doc.pipe(res);

      // Título
      doc.fontSize(22).font('Helvetica-Bold').text('HISTORIAL DE COMPRAS', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(12).font('Helvetica').text(`Cliente: ${req.session.user.nombre}`, { align: 'center' });
      doc.fontSize(10).text(`Generado: ${new Date().toLocaleDateString('es-MX')}`, { align: 'center' });
      doc.moveDown(2);

      // Recorrer cada orden
      ordenes.forEach((orden, index) => {
        if (index > 0) {
          doc.addPage();
        }

        const fechaOrden = new Date(orden.fecha_orden);
        const fechaFormateada = fechaOrden.toLocaleDateString('es-MX', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });

        doc.fontSize(16).font('Helvetica-Bold').text(`Orden #${orden.id}`, { underline: true });
        doc.moveDown(0.5);
        doc.fontSize(11).font('Helvetica');
        doc.text(`Fecha: ${fechaFormateada}`);
        doc.text(`Total: $${Number(orden.total).toFixed(2)}`);
        doc.moveDown(1);

        // Productos de esta orden
        doc.fontSize(12).font('Helvetica-Bold').text('Productos:');
        doc.moveDown(0.5);
        doc.fontSize(10).font('Helvetica');

        const productos = detallesPorOrden[orden.id] || [];
        productos.forEach(prod => {
          const subtotal = Number(prod.subtotal || 0);
          const precioUnit = Number(prod.precio_unitario || 0);
          
          doc.text(`• ${prod.producto_nombre}`);
          doc.text(`  Cantidad: ${prod.cantidad} | Precio: $${precioUnit.toFixed(2)} | Subtotal: $${subtotal.toFixed(2)}`);
          doc.moveDown(0.5);
        });

        doc.moveDown(1);
        doc.strokeColor('#cccccc').lineWidth(1);
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.moveDown(1);
      });

      doc.end();
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});