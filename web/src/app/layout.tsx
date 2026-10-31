import type { Metadata } from "next";
import { Vazirmatn } from "next/font/google";
import "./globals.css";

const vazir = Vazirmatn({
  subsets: ["arabic", "latin"],
  variable: "--font-vazir",
  display: "swap",
  weight: ["300", "400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "تحلیل موقعیت داروخانه — استان خوزستان",
  description:
    "ابزار تحلیل داده‌های ظرفیت داروخانه سازمان غذا و دارو برای انتخاب بهترین شهر جهت تأسیس داروخانه",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fa" dir="rtl" className={vazir.variable}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
