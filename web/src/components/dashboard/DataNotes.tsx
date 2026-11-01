"use client";

import type { HeldOutRow } from "@/lib/dashboardStats";
import { group, shortPlace } from "@/lib/format";
import { Badge, Button } from "../ui";

/**
 * Transparency banner for rows that stay listed but do not score.
 * Renders nothing when there are no important held-out rows.
 */
export function DataNotes({
  rows,
  showFlagged,
  onToggleFlagged,
}: {
  /** Only the important held-out rows (the caller filters). */
  rows: HeldOutRow[];
  showFlagged: boolean;
  onToggleFlagged: () => void;
}) {
  if (!rows.length) return null;

  return (
    <details className="no-print mb-3 rounded-xl border border-warn/30 bg-warn-soft/50 px-3.5 py-2.5">
      <summary className="cursor-pointer text-[12px] font-semibold text-warn">
        ⚠ {group(rows.length)} آبادی به‌دلیل مشکل داده امتیاز نمی‌گیرند — ولی
        همچنان در فهرست هستند. چرا؟
      </summary>
      <div className="mt-2 space-y-1.5 text-[11.5px] leading-5 text-ink-soft">
        <p>
          منبع، دادهٔ عملیاتی زنده است نه دادهٔ پالایش‌شده. ردیف‌هایی که از نظر
          داده ناسالم‌اند همچنان در فهرست می‌مانند و با نشان هشدار مشخص
          می‌شوند — اما <b>امتیاز نمی‌گیرند</b>، چون در غیر این صورت صدر جدول را
          با عددی اشتباه اشغال می‌کنند. اگر عدد درست را بدانید، از پنل جزئیات
          ویرایش کنید تا رتبه‌بندی شود:
        </p>
        <ul className="ms-4 list-disc space-y-0.5">
          <li>
            <b>جمعیت مشکوک:</b> جمعیت کلان‌شهر روی یک آبادی کوچک نشسته است — مثلاً
            «شهر تجریش» با جمعیت ۸٬۱۵۴٬۰۵۱ (جمعیت تهران) و فقط ۱ داروخانه.
          </li>
          <li>
            <b>جمعیت صفر:</b> شهرهایی که جمعیت‌شان صفر ثبت شده و نسبت
            داروخانه‌به‌جمعیت برای‌شان بی‌معناست.
          </li>
          <li>
            <b>نام ناقص:</b> ردیف‌هایی با نام «**» یا «-».
          </li>
          <li>
            <b>بدون هیچ سابقهٔ داروخانه:</b> آبادی بزرگی که نه داروخانه دارد و نه
            متقاضی. این‌ها کنار گذاشته <i>نمی‌شوند</i> — فقط با علامت ⚠ نشان‌دار
            می‌شوند تا خودتان بررسی کنید. نمونه: «مشکین دشت» با ۵۳٬۴۴۰ نفر و صفر
            داروخانه در منبع.
          </li>
        </ul>
        <div className="mt-2 flex flex-wrap gap-1">
          {rows.slice(0, 12).map((h, i) => (
            <Badge key={i} tone="warn" title={h.reason}>
              {shortPlace(h.place)} · {h.county.replace(/^شهرستان\s+/, "")}
            </Badge>
          ))}
        </div>
        <Button variant="outline" className="mt-2" onClick={onToggleFlagged}>
          {showFlagged
            ? "پنهان‌کردن این ردیف‌ها از فهرست"
            : "نمایش دوبارهٔ این ردیف‌ها"}
        </Button>
      </div>
    </details>
  );
}
