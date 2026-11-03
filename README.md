# Nosso Caixa

Controle de finanças do casal, feito para usar no celular (pode ser instalado como app).

- **Início:** sobra do mês, quanto dá para guardar, quanto dá para gastar com lazer e a folga para imprevistos.
- **Contas:** compras parceladas (valor total, nº de parcelas, valor da parcela, meses pagos) e contas fixas.
- **Gastos:** importe o extrato do banco (OFX, CSV ou PDF) e veja o que foi gasto por categoria: comida, lazer, contas, faculdade, transporte e mais.
- **Renda:** quanto cada um ganha e como dividir a sobra.
- **Nós dois:** código de convite para o casal usar o mesmo caixa.

Site estático (HTML, CSS e JS, sem build). Dados no Supabase, nas tabelas `caixa_*`, protegidas por RLS: cada casal só vê o próprio caixa.
O extrato é lido no próprio aparelho; só os lançamentos (data, descrição, valor, categoria) são salvos.
