# ADR-009: El stock nunca queda en negativo

- **Estado:** aceptado (2026-10-07)
- **Contexto:** primera versión de `registrar_venta` permitía vender sin stock y
  avisaba el negativo. En un producto comercial eso se ve roto ("menos dos cocas").
- **Decisión:** la venta valida stock ANTES de escribir nada. Si falta, se frena
  completa con un mensaje amable (qué producto, cuánto hay, cuánto se pidió y cómo
  arreglarlo: ajustar cantidades o fijar stock). Nada se registra a medias.
- **Consecuencias:** el negocio debe tener el stock cargado para vender (lo cargamos
  nosotros en el alta). Si esto fricciona en trials reales, se revisa (ver plan).
