import requests
from bs4 import BeautifulSoup
import sys

def scrape_justetf(isin):
    url = f"https://www.justetf.com/en/etf-profile.html?isin={isin}"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    }
    response = requests.get(url, headers=headers)
    soup = BeautifulSoup(response.text, 'html.parser')
    
    # We look for "Countries" in h3 or similar headers
    headers3 = soup.find_all(['h3', 'h4'])
    for h in headers3:
        if 'Countries' in h.text or 'Country' in h.text:
            print(f"Found country header: {h.text}")
            # Usually the table is a sibling or inside the next div
            parent = h.find_parent('div')
            if parent:
                table = parent.find('table')
                if table:
                    for row in table.find_all('tr'):
                        cols = row.find_all(['td', 'th'])
                        print([c.text.strip() for c in cols])
            
if __name__ == "__main__":
    scrape_justetf("IE00BK5BQT80")
