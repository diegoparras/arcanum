'use strict';

// Suite Escriba: pase entre apps (contrato en docs/suite-pase.md).
//
// Receptora (Factorum -> Arcanum):
//   POST /api/suite/pase       Factorum, con una clave de Arcanum habilitada para la suite, pide
//                              un pase para una persona. Arcanum decide el rol y los CUITs con
//                              lo suyo (usuario existente) o crea el usuario (origen factorum),
//                              y los topea con la clave. Devuelve la URL publica con el pase.
//   GET  /suite/entrar?pase=   canjea el pase (un solo uso, 60 s) y abre la sesion.
// Origen (Arcanum -> Factorum):
//   GET  /api/suite/apps       las apps conectadas (Factorum) y si responden (healthz, 60 s).
//   POST /api/suite/abrir/:app pide el pase a Factorum con FACTORUM_TOKEN y devuelve la URL.
//
// El token del pase nunca se guarda (solo su SHA-256) ni va a un log ni a la auditoria.
//
// Con las reglas de cuentas de 2.1.16/2.1.17: el email, el usuario y los CUITs que llegan de la
// otra app se validan igual que en el alta de usuarios (un CUIT mal formado es un 400, nunca se
// descarta en silencio), admin y superadmin no quedan con una lista de CUITs, el usuario creado
// por un pase no tiene contrasena (no entra por el login normal ni se le puede poner una que no
// cumpla la politica) y quien tiene pendiente cambiar la contrasena inicial no entra con un pase.
// Los pedidos anonimos rechazados en /suite/entrar no dejan fila (M-12).

const crypto = require('crypto');

const ORDEN_ROLES = ['lectura', 'operador', 'admin', 'superadmin'];
// Rol de Factorum -> rol de Arcanum.
const ROL_DESDE_FACTORUM = { superadmin: 'superadmin', admin: 'admin', usuario: 'operador', lectura: 'lectura' };
const APPS = { factorum: { app: 'factorum', nombre: 'Factorum' } };
const TTL_PASE_MS = 60 * 1000;
const TTL_SALUD_MS = 60 * 1000;
const TIMEOUT_SALUD_MS = 3000;
// Rechazos de /suite/entrar que se anotan por minuto (un pase reusado en un loop no llena la tabla).
const MAX_RECHAZOS_POR_MIN = 30;

const MSG = {
  sinFlag: 'Esta clave no está habilitada para abrir sesiones de la suite',
  sinUrl: 'Falta la URL pública de Arcanum',
  desactivado: 'Esa persona está desactivada en Arcanum',
  sinAlta: 'Arcanum no da de alta usuarios que llegan de otra app: pedile a un superadmin de Arcanum que te cree el usuario',
  sinRol: 'No queda ningún rol válido para esa persona en Arcanum',
  sinCuits: 'Esa persona no tiene CUITs en común con los de esta clave',
  debeCambiar: 'Esa persona tiene que entrar a Arcanum con su contraseña y cambiar la inicial antes de usar el pase',
  emailLargo: 'Ese email es demasiado largo para usarlo de usuario en Arcanum: pedile a un superadmin que te cree el usuario',
  paseVencido: 'El pase para entrar venció o ya se usó. Volvé a tocar el botón en la otra app.',
};

function err(message, httpStatus) {
  return Object.assign(new Error(message), { httpStatus });
}

const hashPase = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** El rol mas bajo entre `rol` y `tope` (null si alguno no es un rol de Arcanum). */
function topear(rol, tope) {
  const a = ORDEN_ROLES.indexOf(rol);
  const b = ORDEN_ROLES.indexOf(tope);
  if (a < 0 || b < 0) return null;
  return ORDEN_ROLES[Math.min(a, b)];
}

/**
 * CUITs que manda la otra app: null o ausente = todos; una lista con algo que no es un CUIT, 400
 * (la misma regla que el alta de claves y usuarios, M-10). Lista vacia = todos, como alli.
 */
function normCuits(lista) {
  return require('../auth/permisos').listaCuits(lista, 'cuits');
}

/** Interseccion de dos listas de CUITs donde null = todos. [] = ninguno en comun. */
function intersecar(persona, clave) {
  if (!clave || !clave.length) return persona && persona.length ? persona : null;
  if (!persona || !persona.length) return [...clave];
  return persona.filter((c) => clave.includes(c));
}

function urlLimpia(v) {
  if (v !== undefined && v !== null && typeof v !== 'string') throw err('La URL pública tiene que ser texto', 400);
  const u = String(v || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\/[^\s/?#]+[^\s?#]*$/i.test(u)) throw err('La URL pública tiene que empezar con http:// o https:// (sin ? ni #)', 400);
  let p;
  try { p = new URL(u); } catch { throw err('La URL pública no es válida', 400); }
  if (p.username || p.password) throw err('La URL pública no puede llevar usuario ni clave', 400);
  return u;
}

/** Repositorio en Postgres. `db` es src/db.js (query + tx). */
function repoSql(db) {
  const COLS_U = 'id, username, email, nombre, role, cuit_allow, activo, origen, debe_cambiar';
  return {
    async leerAjustes() {
      try {
        const { rows } = await db.query("SELECT value FROM settings WHERE key = 'suite'");
        return rows[0] && rows[0].value ? JSON.parse(rows[0].value) : {};
      } catch { return {}; }
    },
    async guardarAjustes(valor, usuario) {
      await db.query(
        "INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('suite',$1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=$1, updated_by=$2, updated_at=now()",
        [JSON.stringify(valor), usuario || null],
      );
    },
    async usuarioPorEmail(email) {
      // Por email y, si no tiene, por usuario igual al email. Primero el que coincide por email.
      const { rows } = await db.query(
        `SELECT ${COLS_U} FROM usuarios WHERE lower(email) = lower($1) OR (email IS NULL AND lower(username) = lower($1))
         ORDER BY (lower(email) = lower($1)) DESC NULLS LAST, id LIMIT 1`, [email],
      );
      return rows[0] || null;
    },
    async usuarioPorNombre(username) {
      const { rows } = await db.query(`SELECT ${COLS_U} FROM usuarios WHERE username = $1`, [username]);
      return rows[0] || null;
    },
    /** Crea el usuario sin contrasena (no entra con login local). Si ya existe, devuelve null. */
    async crearUsuario({ email, nombre, role, cuitAllow, origen }) {
      const { rows } = await db.query(
        `INSERT INTO usuarios (username, pass_hash, role, cuit_allow, email, nombre, origen)
         VALUES ($1, '!suite', $2, $3, $1, $4, $5) ON CONFLICT DO NOTHING RETURNING ${COLS_U}`,
        [email, role, cuitAllow, nombre, origen],
      );
      return rows[0] || null;
    },
    async guardarPase(p) {
      await db.query("DELETE FROM suite_pases WHERE vence_at < now() - interval '1 day'");
      await db.query(
        `INSERT INTO suite_pases (token_hash, app, email, username, role, cuit_allow, clave_id, vence_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [p.tokenHash, p.app, p.email, p.username, p.role, p.cuitAllow, p.claveId, p.vence],
      );
    },
    /**
     * Canjea un pase: lo marca usado en la misma sentencia (un solo uso aunque lleguen dos a la
     * vez) y, en la misma transaccion, trae si la persona sigue activa.
     */
    async canjearPase(tokenHash, ahora) {
      return db.tx(async (c) => {
        const { rows } = await c.query(
          `UPDATE suite_pases SET usado_at = now() WHERE token_hash = $1 AND usado_at IS NULL AND vence_at > $2
           RETURNING app, email, username, role, cuit_allow, clave_id`, [tokenHash, ahora],
        );
        if (!rows.length) return null;
        const p = rows[0];
        const { rows: u } = await c.query('SELECT activo, debe_cambiar FROM usuarios WHERE username = $1', [p.username]);
        if (u.length) await c.query('UPDATE usuarios SET last_login = now() WHERE username = $1', [p.username]);
        // Si lo borraron despues de emitir el pase, no entra.
        return { ...p, existe: u.length > 0, activo: u.length ? u[0].activo !== false : false, debe_cambiar: u.length ? !!u[0].debe_cambiar : false };
      });
    },
    /** Un pase que existe pero ya no sirve (usado o vencido): de quien era, para la auditoria. */
    async buscarPase(tokenHash) {
      const { rows } = await db.query('SELECT app, email, username, clave_id, usado_at FROM suite_pases WHERE token_hash = $1', [tokenHash]);
      return rows[0] || null;
    },
    async auditar(e) {
      await db.query(
        `INSERT INTO suite_auditoria (evento, app, email, usuario, rol, clave_id, clave_prefijo, ip, detalle)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [e.evento, e.app || null, e.email || null, e.usuario || null, e.rol || null, e.claveId || null, e.clavePrefijo || null, e.ip || null, e.detalle || null],
      );
    },
    async auditoria(limite = 50) {
      const n = Math.min(Math.max(parseInt(limite, 10) || 50, 1), 500);
      const { rows } = await db.query(
        `SELECT ts, evento, app, email, usuario, rol, clave_id, clave_prefijo, ip, detalle FROM suite_auditoria ORDER BY ts DESC, id DESC LIMIT ${n}`,
      );
      return rows.map((r) => ({
        ts: r.ts, evento: r.evento, app: r.app, email: r.email, usuario: r.usuario, rol: r.rol,
        claveId: r.clave_id, clavePrefijo: r.clave_prefijo, ip: r.ip, detalle: r.detalle,
      }));
    },
  };
}

/**
 * @param {object} deps
 *  - repo: repoSql(db) o uno en memoria (tests)
 *  - factorum: cliente de src/services/factorum.js (config, salud, pase)
 *  - env: variables de entorno (ARCANUM_PUBLIC_URL, o ARCANUM_URL_PUBLICA como en Factorum;
 *    ARCANUM_SUITE_CREAR_USUARIOS)
 *  - ahora: () => ms (tests)
 */
function crearSuite({ repo, factorum, env = process.env, ahora = () => Date.now() } = {}) {
  const fa = () => factorum || require('./factorum');
  const rp = () => repo || repoSql(require('../db'));
  let salud = { ts: 0, ok: false, promesa: null };
  let rechazos = { desde: 0, n: 0 };

  async function auditar(e) {
    try { await rp().auditar(e); } catch (x) { console.error('[arcanum] auditoria de la suite:', x.message); }
  }

  /** URL publica de Arcanum y si se crean usuarios: lo guardado en Ajustes pisa al entorno. */
  async function config() {
    const g = await rp().leerAjustes();
    const deAjustes = g && typeof g.urlPublica === 'string' && g.urlPublica ? g.urlPublica : '';
    let deEntorno = '';
    try { deEntorno = urlLimpia(env.ARCANUM_PUBLIC_URL || env.ARCANUM_URL_PUBLICA); } catch { deEntorno = ''; }
    const crearEnv = !['0', 'false', 'no'].includes(String(env.ARCANUM_SUITE_CREAR_USUARIOS || '').toLowerCase());
    return {
      urlPublica: deAjustes || deEntorno || '',
      urlPublicaDesde: deAjustes ? 'ajustes' : deEntorno ? 'entorno' : null,
      urlPublicaEntorno: deEntorno || null,
      crearUsuarios: typeof g.crearUsuarios === 'boolean' ? g.crearUsuarios : crearEnv,
    };
  }

  async function guardarConfig({ urlPublica, crearUsuarios } = {}, usuario) {
    const previa = await rp().leerAjustes();
    const valor = { ...previa };
    if (urlPublica !== undefined) valor.urlPublica = urlLimpia(urlPublica);
    if (crearUsuarios !== undefined) {
      if (typeof crearUsuarios !== 'boolean') throw err('"crearUsuarios" tiene que ser true o false', 400);
      valor.crearUsuarios = crearUsuarios;
    }
    await rp().guardarAjustes(valor, usuario);
    return config();
  }

  /**
   * POST /api/suite/pase. `clave` es el principal de la clave de API (apikeys.verificar).
   * Devuelve { ok, url, vence } o tira 400/403/409.
   */
  async function emitirPase(clave, cuerpo = {}, { ip } = {}) {
    const base = { app: typeof cuerpo.app === 'string' ? cuerpo.app.slice(0, 20) : null, claveId: clave.claveId || null, clavePrefijo: clave.prefijo || null, ip };
    const users = require('../auth/users');
    let email = '';
    try { email = typeof cuerpo.email === 'string' ? users.normEmail(cuerpo.email) || '' : ''; } catch { email = ''; }
    const rechazar = async (e, detalle) => {
      await auditar({ ...base, evento: 'pase_rechazado', email: email || null, detalle: detalle || e.message });
      throw e;
    };
    if (clave.via !== 'clave' || !clave.suite) return rechazar(err(MSG.sinFlag, 403));
    if (cuerpo.app !== 'factorum') return rechazar(err('"app" tiene que ser "factorum"', 400));
    if (!email) return rechazar(err('Falta "email" o no es un email', 400));
    if (cuerpo.nombre !== undefined && cuerpo.nombre !== null && typeof cuerpo.nombre !== 'string') return rechazar(err('"nombre" tiene que ser texto', 400));
    const nombre = users.normNombre(cuerpo.nombre);
    const cfg = await config();
    if (!cfg.urlPublica) return rechazar(err(MSG.sinUrl, 409));

    const tope = clave.suiteRolTope || 'operador';
    const cuitsClave = clave.cuitAllow && clave.cuitAllow.length ? clave.cuitAllow : null;
    // admin y superadmin ven todos los CUITs: con una clave acotada a CUITs, el tope es operador.
    const topeEfectivo = cuitsClave ? topear(tope, 'operador') : tope;

    let u = await rp().usuarioPorEmail(email);
    if (u && u.activo === false) return rechazar(err(MSG.desactivado, 403));
    if (u && u.debe_cambiar) return rechazar(err(MSG.debeCambiar, 403));
    let rolBase;
    let cuitsBase;
    let creado = false;
    if (u) {
      // Ya existe: manda lo de Arcanum (no se escala por venir de la otra app).
      rolBase = u.role;
      cuitsBase = u.cuit_allow && u.cuit_allow.length ? u.cuit_allow : null;
    } else {
      if (!cfg.crearUsuarios) return rechazar(err(MSG.sinAlta, 403));
      // El usuario de Arcanum es el email: con las mismas reglas que un alta a mano.
      if (!users.usuarioValido(email)) return rechazar(err(MSG.emailLargo, 403));
      rolBase = typeof cuerpo.rol === 'string' && Object.prototype.hasOwnProperty.call(ROL_DESDE_FACTORUM, cuerpo.rol.toLowerCase())
        ? ROL_DESDE_FACTORUM[cuerpo.rol.toLowerCase()] : undefined;
      if (!rolBase) return rechazar(err(MSG.sinRol, 403), `rol de Factorum desconocido: ${String(cuerpo.rol || '').slice(0, 20)}`);
      try { cuitsBase = normCuits(cuerpo.cuits); } catch (e) { return rechazar(e); }
    }
    let rol = topear(rolBase, topeEfectivo);
    if (!rol) return rechazar(err(MSG.sinRol, 403));
    const cuits = intersecar(cuitsBase, cuitsClave);
    if (cuits && !cuits.length) return rechazar(err(MSG.sinCuits, 403));
    // admin y superadmin ven todos los CUITs: con una lista, la persona entra como operador (la
    // lista se cumple). Es la misma regla que el alta de usuarios y claves (M-10).
    if (cuits && ['admin', 'superadmin'].includes(rol)) rol = 'operador';

    if (!u) {
      // Se crea ya topeado: el rol que pidio la otra app nunca queda guardado por encima del tope.
      u = await rp().crearUsuario({ email, nombre, role: rol, cuitAllow: cuits, origen: 'factorum' });
      if (!u) u = await rp().usuarioPorEmail(email); // lo creo otro pedido al mismo tiempo
      if (!u) return rechazar(err(MSG.sinRol, 403), 'no se pudo crear el usuario');
      if (u.activo === false) return rechazar(err(MSG.desactivado, 403));
      creado = true;
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const vence = new Date(ahora() + TTL_PASE_MS);
    await rp().guardarPase({
      tokenHash: hashPase(token), app: 'factorum', email, username: u.username, role: rol, cuitAllow: cuits,
      claveId: clave.claveId || null, vence,
    });
    await auditar({
      ...base, evento: 'pase_emitido', email, usuario: u.username, rol,
      detalle: [creado ? 'usuario creado (origen factorum)' : 'usuario existente', cuits ? `CUITs: ${cuits.join(', ')}` : 'todos los CUITs'].join(' · '),
    });
    return { ok: true, url: `${cfg.urlPublica}/suite/entrar?pase=${token}`, vence: vence.toISOString() };
  }

  /** Tope de filas de rechazos por minuto (lo demas solo cuenta como un 302 al login). */
  function anotarRechazo() {
    const t = ahora();
    if (t - rechazos.desde > 60_000) rechazos = { desde: t, n: 0 };
    rechazos.n += 1;
    return rechazos.n <= MAX_RECHAZOS_POR_MIN;
  }

  /** GET /suite/entrar: el principal de la sesion, o null si el pase no sirve. */
  async function canjearPase(token, { ip } = {}) {
    const t = String(token || '');
    // Un pase con otra forma, o que nunca existio, es un pedido anonimo: no deja fila (M-12).
    if (!/^[A-Za-z0-9_-]{43}$/.test(t)) return null;
    const h = hashPase(t);
    const p = await rp().canjearPase(h, new Date(ahora()));
    if (!p) {
      const viejo = rp().buscarPase ? await rp().buscarPase(h).catch(() => null) : null;
      if (viejo && anotarRechazo()) {
        await auditar({
          evento: 'pase_rechazado', app: viejo.app, email: viejo.email, usuario: viejo.username, claveId: viejo.clave_id, ip,
          detalle: viejo.usado_at ? 'pase ya usado' : 'pase vencido',
        });
      }
      return null;
    }
    if (!p.activo || p.existe === false || p.debe_cambiar) {
      const detalle = p.existe === false ? 'el usuario ya no existe' : !p.activo ? 'usuario desactivado' : 'tiene que cambiar la contraseña inicial';
      await auditar({ evento: 'pase_rechazado', app: p.app, email: p.email, usuario: p.username, claveId: p.clave_id, ip, detalle });
      return null;
    }
    await auditar({ evento: 'pase_usado', app: p.app, email: p.email, usuario: p.username, rol: p.role, claveId: p.clave_id, ip });
    return { username: p.username, role: p.role, cuitAllow: p.cuit_allow && p.cuit_allow.length ? p.cuit_allow : null };
  }

  async function factorumConectado() {
    try {
      const c = await fa().config();
      return !!(c && c.url && c.tokenCargado);
    } catch { return false; }
  }

  /** Healthz de Factorum, cacheado 60 s (lo que respondio, bien o mal). */
  async function factorumDisponible() {
    if (salud.ts && ahora() - salud.ts < TTL_SALUD_MS) return salud.ok;
    if (!salud.promesa) {
      salud.promesa = fa().salud({ timeoutMs: TIMEOUT_SALUD_MS })
        .then((s) => !!(s && s.ok))
        .catch(() => false)
        .then((ok) => { salud = { ts: ahora(), ok, promesa: null }; return ok; });
    }
    return salud.promesa;
  }

  /** GET /api/suite/apps */
  async function apps() {
    if (!(await factorumConectado())) return [];
    return [{ ...APPS.factorum, disponible: await factorumDisponible() }];
  }

  /** POST /api/suite/abrir/:app. `principal` es la sesion del navegador. */
  async function abrir(app, principal, { ip } = {}) {
    if (!APPS[app]) throw err('Esa app de la suite no existe', 404);
    if (principal.via === 'clave' || principal.via === 'maestra') throw err('Las apps de la suite se abren desde una sesión del navegador, no con una clave', 403);
    const u = await rp().usuarioPorNombre(principal.username);
    const base = { app, usuario: principal.username, rol: principal.role, ip };
    const fallar = async (e) => {
      await auditar({ ...base, evento: 'abrir_rechazado', email: (u && u.email) || null, detalle: e.message });
      throw e;
    };
    if (u && u.activo === false) return fallar(err('Tu usuario está desactivado', 403));
    if (!(await factorumConectado())) return fallar(err('Factorum no está conectado a Arcanum', 409));
    let email = u && u.email ? u.email : null;
    if (!email) { try { email = require('../auth/users').normEmail(String(principal.username || '')); } catch { email = null; } }
    if (!email) return fallar(err('Tu usuario de Arcanum no tiene email: un superadmin lo puede cargar en Usuarios', 409));
    const nombre = (u && u.nombre) || principal.username;
    let r;
    try {
      r = await fa().pase({ email, nombre, rol: principal.role, cuits: principal.cuitAllow && principal.cuitAllow.length ? principal.cuitAllow : null });
    } catch (e) {
      return fallar(e.httpStatus ? e : err(`No se pudo contactar a Factorum (${e.message})`, 502));
    }
    await auditar({ ...base, evento: 'abrir', email });
    return { ok: true, url: r.url };
  }

  return {
    config, guardarConfig, emitirPase, canjearPase, apps, abrir,
    auditoria: (limite) => rp().auditoria(limite),
    _reiniciarSalud: () => { salud = { ts: 0, ok: false, promesa: null }; },
  };
}

let unico = null;
/** La instancia del servidor (Postgres y el cliente de Factorum de verdad). */
function servicio() {
  if (!unico) unico = crearSuite();
  return unico;
}

module.exports = { crearSuite, servicio, repoSql, topear, intersecar, normCuits, hashPase, ROL_DESDE_FACTORUM, ORDEN_ROLES, TTL_PASE_MS, TTL_SALUD_MS, MSG };
