# Inicio rápido

[English](QUICKSTART.md) | [简体中文](QUICKSTART.zh.md) | [日本語](QUICKSTART.ja.md) | **Español**

Pagar un enlace de pago de Coinbase (Coinbase Payment Link) de OpenRouter con
USDT/USDC en Solana, BNB Chain, Ethereum, Polygon, Base o Stellar, o con BTC por
Lightning. Cinco minutos. Para saber cómo funciona y por qué, ver
[README.md](../README.md).

## El comando de una sola línea

```bash
npx @rozoai/checkout pay https://payments.coinbase.com/payment-links/pl_01YOURLINKID
```

Eso ejecuta por uno todos los pasos de abajo: elegir moneda, cotizar, crear,
revisar, confirmar, instrucciones de depósito y luego consultar hasta la
liquidación. En el paso de elegir moneda se puede pegar la dirección de la
billetera y el selector consultará los saldos y marcará cuáles se pueden pagar
—es opcional y nunca cambia lo que se firma—.

Si ya se sabe qué moneda usar, se puede indicar y omitir la pregunta:

```bash
npx @rozoai/checkout pay https://payments.coinbase.com/payment-links/pl_01YOURLINKID --with usdt-solana
```

Monedas para `--with`: `usdt-solana`, `usdc-solana`, `usdt-bnb`, `usdc-bnb`, `usdt-ethereum`,
`usdc-ethereum`, `usdt-polygon`, `usdc-polygon`, `usdc-base`, `usdc-stellar`,
`btc-lightning`. Los scripts y los agentes deben pasar siempre `--with`: el
selector solo aparece en una terminal y no hay moneda por defecto.

Por defecto solo imprime una dirección para pagar desde cualquier billetera: sin
clave privada y sin configuración. Añadir `--send` únicamente si se quiere que la
CLI firme desde una billetera caliente, y `--json` para obtener una salida
legible por máquina.

El resto de esta página es el mismo flujo ejecutado paso a paso, que es lo que
conviene si algo sale mal o si se quiere automatizar por cuenta propia.

## Antes de empezar

- **Node 18 o posterior** (`node -v`). No hay nada más que instalar: `npx`
  descarga la CLI, y los `scripts/dist/*.js` del repositorio clonado son
  paquetes autocontenidos.
- **Una billetera** que tenga la moneda con la que se quiere pagar, en la cadena elegida.
- **El enlace de Coinbase**, por ejemplo
  `https://payments.coinbase.com/payment-links/pl_01YOURLINKID`.
- Sin cuenta y sin clave de API. Todos los endpoints de aquí son públicos.

Definirlo una sola vez:

```bash
LINK="https://payments.coinbase.com/payment-links/pl_01YOURLINKID"
```

Ids de cadena: `1` Ethereum · `56` BNB Chain · `137` Polygon · `8453` Base ·
`900` Solana · `1500` Stellar · `lightning` Bitcoin Lightning.

## 1. Cotizarlo (solo lectura, gratis)

```bash
node scripts/dist/quote.js --url "$LINK"
```

```json
{
  "success": true,
  "merchant": "OpenRouter, Inc.",
  "invoice": { "amount": "1050.00", "fiat": { "amount": "1050.00", "currency": "USD" } },
  "callerPays": "1050.00",
  "coinbaseExpiryIso": "2026-08-09T10:00:00.000Z"
}
```

Un `"success": false` con `LINK_NO_LONGER_PAYABLE` significa que el enlace ya
está usado o expirado: pedir uno nuevo y detenerse.

## 2. Crear la orden

```bash
node scripts/dist/create-order.js --url "$LINK" --chain 900 --token USDT
```

No se mueve dinero, y una orden sin fondear simplemente expira. La dirección de
depósito (deposit address) completa se **retiene** en esta etapa: se obtiene un
resumen enmascarado para revisarlo primero.

```json
{
  "success": true,
  "rozoPaymentId": "11111111-2222-4333-8444-555555555555",
  "invoice": { "amount": "1050.000000", "currency": "USD" },
  "deposit": null,
  "depositWithheld": true,
  "display": {
    "chain": "Solana",
    "amount": "1054.410000 USDT",
    "payToMasked": "9WzDXw...AWWM"
  },
  "expiry": { "effectiveDeadlineIso": "2026-08-08T11:00:00.000Z", "minutesOfSlack": 55 }
}
```

Este ejemplo es el caso insignia: una factura de **$1,050.00** por $1,000 de
créditos de OpenRouter. Cualquier factura de hasta **$1,100** se puede pagar así.

**Revisar `display.amount` antes de continuar.** Normalmente es mayor que la
factura: incluye las comisiones del puente (bridge) y de la red. Anotar el
`rozoPaymentId`; todos los comandos posteriores lo usan.

## 3. Confirmar

Solo una vez que se ha decidido pagar, volver a ejecutar el mismo comando con `--confirm`:

```bash
node scripts/dist/create-order.js --url "$LINK" --chain 900 --token USDT --confirm
```

Esto libera el detalle completo del depósito y registra la confirmación que
exigen los scripts de envío.

```json
{
  "success": true,
  "confirmed": true,
  "deposit": {
    "chain": "Solana",
    "tokenSymbol": "USDT",
    "receiverAddress": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    "receiverMemo": "rozo-901",
    "amount": "1054.410000",
    "payTo": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
  }
}
```

Enviar exactamente los campos que entrega este bloque. Para Lightning,
`deposit.lnInvoice` contiene la cadena BOLT11 que hay que escanear, y
`deposit.amount` está en satoshis.

## 4. Pagar

### La forma sencilla: desde la propia billetera

**Sin clave privada, sin variables de entorno, sin configuración.** Abrir
cualquier billetera y enviar exactamente lo que indica el bloque `deposit` de
arriba:

- el `amount` del `tokenSymbol`,
- en la `chain`,
- a la `receiverAddress`, copiada del JSON, nunca tecleada de nuevo.

Si el bloque contiene algún otro campo, como `receiverMemo`, incluirlo tal cual;
forma parte del destino en esa cadena. Para Lightning, escanear o pegar
`deposit.lnInvoice` en su lugar.

Eso es todo el Modo A. Continuar en el paso 5.

### La forma opcional: dejar que el script pague (Modo B)

Solo si se quiere que esta máquina firme por uno, y solo en cadenas EVM y Solana.
Esta es la única parte que necesita una clave privada:

```bash
# Previsualizar exactamente lo que se firmaría — no firma nada
ROZO_CHECKOUT_SOL_KEY=<base58 secret key> \
  node scripts/dist/send-sol.js --rozo-payment-id <rozoPaymentId> --dry-run

# Enviar de verdad. --send es obligatorio.
ROZO_CHECKOUT_SOL_KEY=<base58 secret key> \
  node scripts/dist/send-sol.js --rozo-payment-id <rozoPaymentId> --send
```

Usar `send-evm.js` con `ROZO_CHECKOUT_EVM_KEY` para Ethereum, BNB Chain,
Polygon y Base. Un solo pago no puede superar los **$1,100**; por encima de eso,
pagar desde la propia billetera como se explica arriba.

```json
{
  "success": true,
  "submitted": true,
  "confirmed": true,
  "txHash": "3Bxs4h24hBjHziQ8UJqSjqjbjWQq2sQ3yV9Fq4HrVh5c"
}
```

## 5. Observar la liquidación

```bash
node scripts/dist/status.js --rozo-payment-id <rozoPaymentId> --watch --timeout 600
```

```json
{
  "success": true,
  "state": "settled",
  "terminal": true,
  "payin": { "txHash": "3Bxs4h24...", "confirmedAt": "2026-08-08T10:05:00.000Z" }
}
```

Los estados van `awaiting_deposit` → `payin_detected` → `payin_confirmed` →
`bridging` → `paying_coinbase` → `settled`. Que la transacción on-chain se
confirme no es el final: seguir consultando hasta `settled`.

## Si algo sale mal

Leer `error.code`. Los tres con los que es más probable toparse:

| `error.code` | Qué ocurrió | Qué hacer |
|---|---|---|
| `LINK_NO_LONGER_PAYABLE` | alguien ya pagó el enlace, o expiró | pedir al comercio un enlace nuevo; no pagar nada |
| `EXPIRY_MARGIN` | queda muy poco tiempo para fondear, puentear y liquidar de forma segura | dejar que la orden expire y volver a empezar desde el paso 1 |
| `ALREADY_SENT` | ya hay un envío registrado para esta orden | **no** enviar de nuevo; ejecutar `status.js` y revisar primero la cadena |

**Si algo de dinero ya salió de la billetera, nunca pagar de nuevo.** Conservar
el `linkId`, el `rozoPaymentId` y todos los hashes de transacción, y pedir a una
persona que lo concilie. No hay garantía de que un segundo pago a una dirección
de depósito de un solo uso sea acreditado.

La tabla completa de errores está en [README.md](../README.md), y las instrucciones
dirigidas al agente están en [SKILL.md](../SKILL.md).
