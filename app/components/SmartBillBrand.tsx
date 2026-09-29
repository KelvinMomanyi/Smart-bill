import { SMARTBILL_ICON_PATH } from "../utils/branding";
import styles from "../styles/brand.module.css";

type SmartBillBrandProps = {
  size?: number;
  showName?: boolean;
};

export function SmartBillBrand({
  size = 40,
  showName = true,
}: SmartBillBrandProps) {
  return (
    <span className={styles.brand}>
      <img
        className={styles.icon}
        src={SMARTBILL_ICON_PATH}
        srcSet="/brand/smartbill-icon-64.png 64w, /brand/smartbill-icon-128.png 128w, /brand/smartbill-icon-256.png 256w"
        sizes={`${size}px`}
        width={size}
        height={size}
        alt={showName ? "" : "SmartBill"}
      />
      {showName && <span>SmartBill</span>}
    </span>
  );
}
