# Mock data

Données de référence : exports CSV de la documentation Gitbook (RealT).

Fichiers utilisés pour vérifier la cohérence du JSON produit par l’outil :

- **Liquidations RMM - Liquidateurs v2.csv** / **v3.csv** : classement des liquidateurs par nombre de liquidations (référence pour les totaux et le top liquidateurs).
- **Liquidations RMM - RMM v2.csv** / **RMM v3.csv** (et WrapperV3) : détail des événements si besoin.

Pour comparer le JSON avec ces mock data (totaux + classement) :

```bash
node compare-mock-data.js
```

Le JSON produit par `npm run fetch` (ou `node fetch-rmm-liquidators.js`) contient désormais `v2_total_events`, `v3_total_events`, `liquidators_v2_total` et `liquidators_v3_total` (avec `count` et `amount`), ce qui permet la comparaison des totaux et du classement.