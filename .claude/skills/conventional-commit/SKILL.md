---
name: conventional-commit
description: Arma y crea commits siguiendo Conventional Commits con el estilo del repo (mensajes en español). Se usa cuando el usuario pide commitear, hacer un commit, escribir o revisar un mensaje de commit.
---

# Conventional Commit

Cada commit es UN cambio lógico con un mensaje que explica qué cambió y por qué.
Antes de commitear, mirá qué hay realmente en el diff: el mensaje describe lo que
está staged, no lo que creés que hiciste.

## Formato

```
<tipo>(<scope>): <descripción>

<cuerpo opcional>

<footers opcionales>
```

### Tipo (obligatorio)
- `feat`: funcionalidad nueva para el usuario.
- `fix`: corrección de un bug.
- `docs`: solo documentación (PRD, AGENTS.md, README).
- `test`: agregar o corregir tests, sin cambiar código de producción.
- `refactor`: cambio de código que no agrega funcionalidad ni corrige bugs.
- `perf`: mejora de rendimiento.
- `style`: formato, espacios, punto y coma; sin cambio de lógica.
- `build`: dependencias, npm workspaces, Vite, configuración de TypeScript.
- `ci`: pipelines de integración continua.
- `chore`: tareas de mantenimiento que no entran en otro tipo.
- `revert`: revierte un commit anterior (citá su hash en el cuerpo).

### Scope (recomendado)
El área del repo que toca el cambio, en minúsculas salvo siglas: `server`, `web`,
`db`, `arca`, `email`, `llm`, `jobs`, `PRD`, `skills`, `agents`. Si el cambio
toca varias áreas sin una dominante, omití el scope. Si no encaja en uno solo,
probablemente son dos commits.

### Descripción (obligatoria)
- En español, en infinitivo y en minúscula: "agregar", "corregir", "eliminar"
  (no "agregado", "agrega" ni "Agregar").
- Sin punto final y con un máximo de 72 caracteres para toda la primera línea.
- Dice qué cambia, no cómo: `fix(email): ignorar las imágenes embebidas como adjuntos`.

### Cuerpo (cuando el porqué no es obvio)
- Separado de la primera línea por una línea en blanco, con líneas de hasta 72 caracteres.
- Explica el motivo y el contexto, no repite el diff.
- Si el cambio implementa o modifica requisitos del PRD, citá sus IDs (RF-xx, AC-xx).

### Footers
- `BREAKING CHANGE: <qué se rompe y cómo migrar>` cuando el cambio rompe
  compatibilidad (API, schema, variables de entorno). Además agregá `!` después
  del tipo o scope: `feat(db)!: ...`.
- `Refs: #<issue>` o `Closes: #<issue>` si hay un issue asociado.
- Mantené las líneas de atribución (por ejemplo, `Co-Authored-By`) que pida el entorno.

## Pasos

1. Corré `git status` y `git diff --staged` (y `git diff` si no hay nada staged).
2. Si hay cambios que no tienen que ver entre sí, proponé separarlos en varios
   commits y stageá solo lo que corresponde a cada uno (`git add <archivos>`;
   nunca `git add -A` a ciegas).
3. Verificá que no se cuele nada prohibido por AGENTS.md: `.env`, `certs/`,
   `*.crt`, `*.key`, `*.pem`, API keys o contraseñas. Si aparece algo, frená y avisá.
4. No incluyas cambios de otra persona que no te pidieron commitear: si hay
   archivos modificados ajenos a la tarea, dejalos fuera y mencionalo.
5. Elegí tipo y scope, y redactá el mensaje con las reglas de arriba.
6. Commiteá pasando el mensaje con un heredoc (`git commit -F -`) para que el
   cuerpo y los footers mantengan el formato.
7. Mostrá `git log --oneline -1` y el resumen de archivos incluidos.
8. No hagas push salvo que el usuario lo pida explícitamente.

## Ejemplos

```
feat(llm): clasificar cada adjunto del email por separado

El agente asignaba una sola clasificación a todo el email. Ahora clasifica
cada adjunto y deriva la del email según RF-123.
```

```
fix(arca): reutilizar el CAE cuando WSFEv1 no respondió a tiempo

Evita emitir dos comprobantes para la misma factura (RF-75, AC-73).
```

```
docs(PRD): reemplazar el PRD original por PRD-002
```

```
feat(db)!: guardar los montos en centavos como enteros

BREAKING CHANGE: las columnas de montos pasan de REAL a INTEGER. Correr la
migración nueva antes de levantar el server.
```

## Qué evitar
- Mensajes vagos: "cambios", "fix", "update", "wip", "varios ajustes".
- Mezclar en un mismo commit un refactor con un fix o una feature.
- Describir el cómo en vez del qué ("cambiar un if en processEmail").
- Usar `--no-verify` o `--amend` sobre commits ya pusheados sin que el usuario lo pida.
