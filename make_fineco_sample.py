"""Generate synthetic Fineco export files in sample_fineco/ for manual testing.

Mimics the real exports' quirks: preamble rows above the header, Segno A/V,
unsigned Controvalore, separate Commissioni, Entrate/Uscite columns, and
securities-settlement rows in the movements file that must be skipped.
"""
import os
from openpyxl import Workbook

OUT = os.path.join(os.path.dirname(__file__), 'sample_fineco')
os.makedirs(OUT, exist_ok=True)


def write(path, rows):
    wb = Workbook()
    ws = wb.active
    for r in rows:
        ws.append(r)
    wb.save(path)
    print('wrote', path)


write(os.path.join(OUT, 'ordini_contabili.xlsx'), [
    ['FinecoBank - Ordini e Contabili'],
    ['Conto: 1234567 - Periodo: 01/01/2025 - 30/06/2025'],
    [],
    ['Data Operazione', 'Segno', 'Descrizione', 'ISIN', 'Simbolo', 'Quantità', 'Prezzo', 'Divisa', 'Controvalore', 'Commissioni'],
    ['02/01/2025', 'A', 'VANGUARD FTSE ALL-WORLD', 'IE00BK5BQT80', 'VWCE', '3,4188', '117,00', 'EUR', '400,00', '2,95'],
    ['20/01/2025', 'A', 'APPLE INC', 'US0378331005', 'AAPL', '1,05', '238,10', 'EUR', '250,00', '3,95'],
    ['10/02/2025', 'A', 'ISHARES CORE GLOBAL AGGREGATE BOND', 'IE00BDBRDM35', 'AGGH', '30', '5,00', 'EUR', '150,00', '2,95'],
    ['05/03/2025', 'A', 'VANGUARD FTSE ALL-WORLD', 'IE00BK5BQT80', 'VWCE', '3,3333', '120,00', 'EUR', '400,00', '2,95'],
    ['02/04/2025', 'V', 'APPLE INC', 'US0378331005', 'AAPL', '0,5', '240,00', 'EUR', '120,00', '3,95'],
])

write(os.path.join(OUT, 'movimenti_conto.xlsx'), [
    ['FinecoBank - Movimenti Conto Corrente'],
    ['Conto: 1234567'],
    [],
    ['Data Operazione', 'Data Valuta', 'Entrate', 'Uscite', 'Descrizione', 'Descrizione_Completa'],
    ['01/01/2025', '01/01/2025', '1.500,00', '', 'Bonifico', 'Bonifico in entrata da conto esterno'],
    ['02/01/2025', '02/01/2025', '', '-402,95', 'Compravendita Titoli', 'Eseguito acquisto VWCE'],
    ['20/01/2025', '20/01/2025', '', '-253,95', 'Compravendita Titoli', 'Eseguito acquisto AAPL'],
    ['15/03/2025', '15/03/2025', '1,87', '', 'Stacco Cedole/Dividendi', 'Dividendo APPLE INC'],
    ['31/03/2025', '31/03/2025', '', '-34,20', 'Imposta bollo dossier titoli', 'Imposta di bollo su deposito titoli'],
    ['02/04/2025', '02/04/2025', '116,05', '', 'Compravendita Titoli', 'Eseguito vendita AAPL'],
    ['10/04/2025', '10/04/2025', '', '-100,00', 'Prelievo Bancomat', 'Prelievo ATM Milano'],
    ['30/06/2025', '30/06/2025', '0,45', '', 'Competenze di liquidazione', 'Interessi attivi netti'],
])
