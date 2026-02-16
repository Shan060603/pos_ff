# Farmfresh POS (pos_ff)

A custom ERPNext POS app designed for a seamless, fast retail and restaurant experience.

## Key Features
* **Auto-Adapt UI**: Responsive interface that adapts to any screen size (Mobile, Tablet, Desktop).
* **Automated Barcode Scanning**: High-speed scanning logic that adds items to the cart automatically without needing to press "Enter".
* **Restaurant Ready**: Includes Table Management, KOT (Kitchen Order Ticket) firing, and Table Transfers.
* **Shift Management**: Robust Opening and Closing shift logic with automated reconciliation to prevent balance discrepancies.

## Installation

1.  **Get the app from GitHub:**
    ```bash
    bench get-app [https://github.com/Shan060603/pos_ff.git](https://github.com/Shan060603/pos_ff.git)
    ```

2.  **Install the app on your site:**
    ```bash
    bench --site [your-site-name] install-app pos_ff
    ```

3.  **Migrate and Build:**
    ```bash
    bench migrate
    bench build
    ```

## Configuration
* Ensure **Item Barcodes** are maintained in the Item Master.
* The scanner expects a high-speed input (100ms threshold).
