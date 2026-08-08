# rozo-checkout

[English](../README.md) | [简体中文](README.zh.md) | [日本語](README.ja.md) | **Español**

Pagar un **enlace de pago de Coinbase (Payment Link) de OpenRouter** con una
moneda que ese enlace no puede aceptar directamente: BTC por Lightning, o
USDT/USDC en Solana, BNB Chain, Ethereum, Polygon, Base o Stellar. Un enlace de
pago de Coinbase solo acepta USDC en Base; esto enruta la moneda que realmente
se posee a través de un puente, y una billetera fondeadora liquida la factura en
nombre del usuario. Sin cuenta, sin clave de API, sin navegador.

```bash
npx @rozoai/checkout pay <coinbase-link>
```

Primero pregunta con qué moneda se quiere pagar —al pegar la dirección de la
billetera en el prompt, marca cuáles se pueden pagar con el saldo disponible— y
luego imprime una dirección de depósito para pagar desde cualquier billetera
—**sin clave privada, sin variable de entorno, sin configuración**—. Después
espera hasta que la factura quede liquidada.

¿Ya se sabe qué moneda usar? Se puede omitir la pregunta:

```bash
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

## Monedas con las que se puede pagar

| Cadena | `--with` | Id de cadena | Notas |
|---|---|---|---|
| Ethereum | `usdt-ethereum` `usdc-ethereum` | `1` | 6 decimales |
| BNB Chain | `usdt-bnb` `usdc-bnb` | `56` | 18 decimales |
| Polygon | `usdt-polygon` `usdc-polygon` | `137` | 6 decimales |
| Base | `usdc-base` | `8453` | 6 decimales |
| Solana | `usdt-solana` `usdc-solana` | `900` | SPL; SOL nativo no admitido |
| Stellar | `usdc-stellar` | `1500` | memo obligatorio — se muestra en el bloque de depósito |
| Bitcoin Lightning | `btc-lightning` | `lightning` | BOLT11; importes en satoshis |

Las monedas de gas nativas (SOL, BNB, ETH, MATIC) y el BTC on-chain no se aceptan.

## ¿Qué wallet necesito?

**Una wallet, en una cadena: no hace falta una por cada cadena.** Elige de la
tabla de arriba la moneda que ya tengas y paga desde donde ya esté.

- **Sirve cualquier wallet, y también un retiro desde un exchange.** La vía por
  defecto solo imprime un bloque de depósito: envía exactamente ese `amount` de
  ese `tokenSymbol`, en esa `chain`, a esa `receiverAddress`. Nada se conecta a
  ningún sitio ni se aprueba en el navegador. En la práctica la gente usa
  MetaMask o Rabby en las cadenas EVM, Phantom o Solflare en Solana, y una
  wallet Lightning como Phoenix o Wallet of Satoshi para BTC.
- **Stellar es la que exige cuidado.** Sus depósitos se enrutan mediante una
  dirección compartida más `receiverMemo`, así que aquello desde lo que envíes
  — exchange o wallet — debe permitirte fijar un memo. Si lo omites, el pago se
  pierde.
- **Lightning paga una factura, no una dirección.** Escanea o pega
  `deposit.lnInvoice`; no hay ninguna dirección a la que enviar.
- **Solo `--send` necesita una clave privada**, leída de
  `ROZO_CHECKOUT_EVM_KEY` o `ROZO_CHECKOUT_SOL_KEY`, y cubre únicamente las
  cadenas EVM y Solana. Todo lo demás no usa claves.

## Usarlo desde el agente

La carga útil es la misma en todas partes: el comando de una línea de arriba, o
apuntar al agente a [llms.txt](../llms.txt). **Pagar desde la propia billetera
nunca necesita una clave.** Solo la bandera opcional `--send` firma en local, y
solo esa bandera lee `ROZO_CHECKOUT_EVM_KEY` / `ROZO_CHECKOUT_SOL_KEY`. Los agentes y los scripts deben
pasar siempre `--with`: el selector solo aparece en una terminal y no hay moneda
por defecto de forma deliberada.

<details>
<summary><b>Claude Code</b> — instalar la habilidad, o pegar el comando de una línea</summary>

Este repositorio es una habilidad de Claude Code: incluye `SKILL.md` más los
ejecutables de `scripts/dist/`. Basta con clonarlo en el directorio de
habilidades y Claude Code lo detecta automáticamente.

```bash
git clone https://github.com/RozoAI/rozo-checkout-skill ~/.claude/skills/rozo-checkout
```

O saltarse la instalación y simplemente pedirle que ejecute:

```
Paga este enlace de OpenRouter con USDT en Solana:
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

Billetera: cualquier billetera, **sin clave**. Añadir `--send` solo si se quiere
que Claude firme desde una billetera caliente, lo cual necesita la clave del entorno.
</details>

<details>
<summary><b>Codex CLI</b> — AGENTS.md, o ejecutarlo directamente</summary>

Codex lee `AGENTS.md` desde la raíz del proyecto. Conviene añadir una
instrucción permanente para que sepa cómo pagar sin que haya que explicárselo
cada vez:

```
Para pagar un enlace de pago de OpenRouter / Coinbase, ejecuta:
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

Billetera: cualquier billetera, **sin clave**. `--send` sí necesita la clave del entorno.
</details>

<details>
<summary><b>OpenCode</b> — AGENTS.md, o ejecutarlo directamente</summary>

OpenCode también lee `AGENTS.md` desde la raíz del proyecto, así que el fragmento
de Codex de arriba funciona sin cambios. El camino más corto sigue siendo el
propio comando:

```bash
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

Billetera: cualquier billetera, **sin clave**. `--send` sí necesita la clave del entorno.
</details>

<details>
<summary><b>Cline</b> — .clinerules, o ejecutarlo directamente</summary>

Cline lee las instrucciones permanentes desde `.clinerules` en la raíz del proyecto:

```
Para pagar un enlace de pago de OpenRouter / Coinbase, ejecuta:
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

Billetera: cualquier billetera, **sin clave**. `--send` sí necesita la clave del entorno.
</details>

<details>
<summary><b>Cursor</b> — .cursor/rules, o ejecutarlo directamente</summary>

Añadir una regla de proyecto en `.cursor/rules/rozo-checkout.mdc`:

```
Para pagar un enlace de pago de OpenRouter / Coinbase, ejecuta:
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

Billetera: cualquier billetera, **sin clave**. `--send` sí necesita la clave del entorno.
</details>

<details>
<summary><b>Hermes Agent</b> — ejecutar el comando de una línea en una sesión</summary>

Hermes Agent (Nous Research) tiene acceso a la shell y su propio sistema de
habilidades. Se inicia con `hermes` y se le pide:

```
Descarga https://checkout.rozo.ai/llms.txt y luego paga este enlace de OpenRouter:
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

Billetera: cualquier billetera, **sin clave**. `--send` sí necesita la clave del entorno.
</details>

<details>
<summary><b>OpenClaw</b> — openclaw agent exec</summary>

El punto de entrada headless de OpenClaw ejecuta una tarea puntual, lo que encaja
con un pago que se dispara desde un script o desde un canal de chat:

```bash
openclaw agent exec "Pay this OpenRouter link with USDT on Solana by running: npx @rozoai/checkout pay <coinbase-link> --with usdt-solana"
```

Billetera: cualquier billetera, **sin clave**. `--send` sí necesita la clave del entorno.
</details>

<details>
<summary><b>Pi</b> — ejecutar el comando de una línea en una sesión</summary>

Pi es un agente de terminal BYOK cuyas herramientas integradas incluyen `bash`,
así que puede ejecutar el comando directamente. Se inicia con `pi` y se le pide:

```
Paga este enlace de OpenRouter con USDT en Solana ejecutando:
npx @rozoai/checkout pay <coinbase-link> --with usdt-solana
```

Billetera: cualquier billetera, **sin clave**. `--send` sí necesita la clave del entorno.
</details>

<details>
<summary><b>Terminal — sin ningún agente</b> — ejecutar los scripts paso a paso</summary>

Conducir cada paso a mano. Los paquetes son autocontenidos; no hay nada que
instalar más allá de Node 18+.

```bash
git clone https://github.com/RozoAI/rozo-checkout-skill && cd rozo-checkout-skill
LINK="https://payments.coinbase.com/payment-links/pl_01YOURLINKID"

# Cotización de solo lectura, no cuesta nada
node scripts/dist/quote.js --url "$LINK"

# Crear la orden. Aquí se RETIENE la dirección de depósito completa; primero se
# obtiene un resumen enmascarado para revisar.
node scripts/dist/create-order.js --url "$LINK" --chain 900 --token USDT

# Una vez decidido el pago, volver a ejecutar con --confirm para liberarla
node scripts/dist/create-order.js --url "$LINK" --chain 900 --token USDT --confirm

# Pagar el bloque de depósito desde cualquier billetera y observar la liquidación
node scripts/dist/status.js --rozo-payment-id <uuid> --watch
```

Cada script imprime exactamente un objeto JSON en stdout. Código de salida `0`
éxito, `1` rechazado/fallido (leer `error.code`), `2` uso incorrecto, `3` enviado
pero sin confirmar. Recorrido completo: [QUICKSTART](QUICKSTART.es.md).

Billetera: cualquier billetera, **sin clave**. Para el envío desde billetera
caliente, ver `send-evm.js` / `send-sol.js`, que leen `ROZO_CHECKOUT_EVM_KEY` /
`ROZO_CHECKOUT_SOL_KEY`.
</details>

<details>
<summary><b>Cualquier otro agente</b> — apuntarlo a llms.txt</summary>

Cualquier agente capaz de descargar una URL y ejecutar un comando puede hacer esto:

```
Descarga https://checkout.rozo.ai/llms.txt a tu contexto y úsalo
para pagar este enlace de OpenRouter: <coinbase-link>
```

Si el agente no tiene shell pero puede hacer peticiones HTTP, puede manejar
directamente los cuatro endpoints públicos — ver [cómo funciona](how-it-works.md).

Billetera: cualquier billetera, **sin clave**. `--send` sí necesita la clave del entorno.
</details>

## Tres reglas que conviene conocer

- **La dirección de depósito es de un solo uso.** Nunca reutilizar una de una
  orden anterior, de una respuesta cacheada o de una captura de pantalla.
- **Enviar exactamente el importe mostrado.** Normalmente es mayor que la
  factura: incluye las comisiones del puente y de la red.
- **Nunca pagar dos veces una orden ya fondeada.** Si ya se ha detectado un
  pago, detenerse y pedir a una persona que lo concilie; un segundo pago a una
  dirección de un solo uso no tiene garantía de ser acreditado.

La lista completa de lo que esta herramienta se niega a hacer, y por qué, está en
[docs/safety.md](safety.md).

## Enlaces

- [Inicio rápido](QUICKSTART.es.md) — los cinco comandos, con la salida esperada
- [Cómo funciona](how-it-works.md) — el flujo, los endpoints, los identificadores
- [Diseño de seguridad](safety.md) — cada salvaguarda, en detalle
- [SKILL.md](../SKILL.md) — instrucciones dirigidas al agente · [llms.txt](../llms.txt) — resumen en un solo archivo
- [checkout.rozo.ai/agent](https://checkout.rozo.ai/agent.html) — lo mismo, en la web
- [Issues](https://github.com/RozoAI/rozo-checkout-skill/issues) — errores y solicitudes

## Registro de cambios

- **0.1.1** — un solo límite de gasto en lugar de dos: un pago individual no
  puede superar los $1,100 (dimensionado para una compra de crédito de $1,000
  más su comisión del 5%); se eliminan el tope acumulado por sesión y la bandera
  `--yes-large`. La documentación deja explícito que pagar desde la propia
  billetera no necesita clave ni configuración.
- **0.1.0** — primera versión: `npx @rozoai/checkout`.

## Licencia

MIT.
