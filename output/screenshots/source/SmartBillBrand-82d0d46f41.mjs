import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { SMARTBILL_ICON_PATH } from "file:///C:/Users/user/Desktop/SMARTBILL/smart-bill/output/screenshots/source/branding-ede50a1f3b.mjs";
import styles from "file:///C:/Users/user/Desktop/SMARTBILL/smart-bill/output/screenshots/source/brand.module-aa02f15f94.mjs";
export function SmartBillBrand({ size = 40, showName = true, }) {
    return (_jsxs("span", { className: styles.brand, children: [_jsx("img", { className: styles.icon, src: SMARTBILL_ICON_PATH, srcSet: "/brand/smartbill-icon-64.png 64w, /brand/smartbill-icon-128.png 128w, /brand/smartbill-icon-256.png 256w", sizes: `${size}px`, width: size, height: size, alt: showName ? "" : "SmartBill" }), showName && _jsx("span", { children: "SmartBill" })] }));
}
