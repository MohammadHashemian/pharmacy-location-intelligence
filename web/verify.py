import re, sys, urllib.request

URL = "http://localhost:3737/"
try:
    with urllib.request.urlopen(URL, timeout=45) as r:
        html = r.read().decode("utf-8", "replace")
        status = r.status
except Exception as e:
    print("FETCH FAILED:", type(e).__name__, e)
    sys.exit(1)

print("status:", status, "bytes:", len(html))

checks = {
    "page heading": "انتخاب موقعیت داروخانه",
    "tab ranking": "رتبه‌بندی و مرتب‌سازی",
    "tab whitespace": "فضای خالی بازار",
    "tab counties": "شهرستان‌ها",
    "tab charts": "نمودارها",
    "tab data": "داده و منبع",
    "stat best pick": "بهترین گزینهٔ فعلی",
    "stat avg density": "میانگین اشباع استان",
    "controls weights": "اندازه بازار (جمعیت)",
    "col opportunity": "امتیاز فرصت",
    "col capacity": "ظرفیت قابل جذب",
    "province badge": "استان خوزستان",
}
for label, needle in checks.items():
    print(f"  {'OK  ' if needle in html else 'MISS'} {label}")

cities = re.findall(r"اهواز|دزفول|آبادان|خرمشهر|بهبهان|شوشتر|اندیمشک|ایذه|رامهرمز|امیدیه", html)
print("\ndistinct city names present:", len(set(cities)), sorted(set(cities)))
print("server-rendered <table> count:", len(re.findall(r"<table", html)))
print("server-rendered <tr> count:", len(re.findall(r"<tr", html)))

for marker in ["Application error", "Internal Server Error", "Unhandled Runtime Error"]:
    if marker in html:
        print("!! ERROR MARKER:", marker)

txt = re.sub(r"<[^>]+>", " ", html)
txt = re.sub(r"\s+", " ", txt)
i = txt.find("انتخاب موقعیت داروخانه")
print("\n--- visible text sample ---")
print(txt[i:i + 900] if i >= 0 else "(heading not found)")
