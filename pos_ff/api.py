import frappe
import json
from frappe.utils import flt, now_datetime, today, get_datetime
from frappe import _

# --- SHIFT MANAGEMENT ---

def get_assigned_pos_profile():
    """Helper to fetch the POS Profile for the current user"""
    user = frappe.session.user
    profile_name = frappe.db.get_value("POS Profile User", {"user": user}, "parent")
    if not profile_name:
        frappe.throw(_("No POS Profile assigned to user {0}. Please configure a POS Profile.").format(user))
    return frappe.get_doc("POS Profile", profile_name)

@frappe.whitelist()
def check_pos_opening():
    profile = get_assigned_pos_profile()
    opening_entry = frappe.db.get_value("POS Opening Entry", 
        {"pos_profile": profile.name, "user": frappe.session.user, "status": "Open", "docstatus": 1}, 
        "name"
    )
    return {
        "opening_entry": opening_entry,
        "pos_profile": profile.name,
        "company": profile.company
    }

@frappe.whitelist()
def create_opening_entry(pos_profile, amount=0):
    doc = frappe.new_doc("POS Opening Entry")
    doc.pos_profile = pos_profile
    doc.user = frappe.session.user
    doc.company = frappe.db.get_value("POS Profile", pos_profile, "company")
    doc.period_start_date = now_datetime()
    
    profile_doc = frappe.get_doc("POS Profile", pos_profile)
    if profile_doc.payments:
        doc.append("balance_details", {
            "mode_of_payment": profile_doc.payments[0].mode_of_payment,
            "opening_amount": flt(amount)
        })
    
    doc.insert()
    doc.submit()
    return doc.name

# --- DATA FETCHING ---

@frappe.whitelist()
def get_pos_data():
    profile = get_assigned_pos_profile()
    
    items = frappe.db.sql("""
        SELECT 
            i.item_code, i.item_name, i.image,
            COALESCE((SELECT price_list_rate FROM `tabItem Price` WHERE item_code = i.item_code AND price_list = %s LIMIT 1), i.standard_rate) as standard_rate
        FROM `tabItem` i
        WHERE i.disabled = 0 AND i.is_sales_item = 1
    """, (profile.selling_price_list,), as_dict=1)
    
    tables = frappe.get_all("Restaurant Table", 
        fields=["name", "status"],
        filters={"company": profile.company}
    )
    
    return {
        "items": items, 
        "tables": tables,
        "profile_settings": {
            "name": profile.name,
            "company": profile.company,
            "warehouse": profile.warehouse,
            "cost_center": profile.cost_center,
            "selling_price_list": profile.selling_price_list,
            "payments": [{"mode_of_payment": p.mode_of_payment} for p in profile.payments]
        }
    }

# --- TABLE & KOT LOGIC ---

@frappe.whitelist()
def update_table_status(table, status):
    if not table or not status: return False
    frappe.db.set_value("Restaurant Table", table, "status", status)
    frappe.db.commit()
    return True

@frappe.whitelist()
def get_table_orders(table):
    profile = get_assigned_pos_profile()
    kots = frappe.get_all("Kitchen Order Ticket", 
        filters={"table": table, "company": profile.company, "docstatus": 0}, 
        fields=["name"]
    )
    all_items = []
    for k in kots:
        items = frappe.get_all("KOT Item", 
            filters={"parent": k.name}, 
            fields=["item_code", "item_name", "qty", "rate", "discount_percentage", "description as note"]
        )
        for item in items:
            item['is_fired'] = 1 
            if not item.get('item_name'):
                item['item_name'] = item.get('item_code')
            all_items.append(item)
    return all_items

@frappe.whitelist()
def create_kot(table, items, customer_name="Walk-in"):
    profile = get_assigned_pos_profile()
    if isinstance(items, str): items = json.loads(items)
    
    if not frappe.db.exists("Customer", customer_name):
        if customer_name == "Walk-in":
            cust = frappe.get_doc({
                "doctype": "Customer", "customer_name": "Walk-in",
                "customer_group": "Individual", "territory": "All Territories"
            }).insert(ignore_permissions=True)
            customer_name = cust.name

    new_items = [i for i in items if not i.get('is_fired')]
    if not new_items: return "No new items to fire"

    kot = frappe.get_doc({
        "doctype": "Kitchen Order Ticket",
        "table": table,
        "company": profile.company,
        "customer_name": customer_name,
        "order_time": now_datetime(),
        "items": []
    })
    
    for i in new_items:
        kot.append("items", {
            "item_code": i.get("item_code"),
            "item_name": i.get("item_name") or i.get("item_code"), 
            "qty": i.get("qty"),
            "rate": i.get("rate"),
            "description": i.get("note"),
            "discount_percentage": flt(i.get("discount_percentage", 0)) 
        })
    
    kot.insert()
    frappe.db.set_value("Restaurant Table", table, "status", "Occupied")
    frappe.db.commit()
    return kot.name

@frappe.whitelist()
def transfer_table(old_table, new_table):
    profile = get_assigned_pos_profile()
    if frappe.db.get_value("Restaurant Table", new_table, "status") == "Occupied":
        frappe.throw(_("Target table {0} is already occupied.").format(new_table))
        
    frappe.db.sql("""
        UPDATE `tabKitchen Order Ticket` 
        SET `table` = %s 
        WHERE `table` = %s AND `company` = %s AND `docstatus` = 0
    """, (new_table, old_table, profile.company))
    
    frappe.db.set_value("Restaurant Table", old_table, "status", "Available")
    frappe.db.set_value("Restaurant Table", new_table, "status", "Occupied")
    frappe.db.commit()
    return True

# --- INVOICING ---

@frappe.whitelist()
def create_invoice(table, mode_of_payment="Cash", amount_paid=0, customer=None):
    profile = get_assigned_pos_profile()
    
    opening_entry = frappe.db.get_value("POS Opening Entry", 
        {"pos_profile": profile.name, "user": frappe.session.user, "status": "Open", "docstatus": 1}, 
        "name"
    )
    if not opening_entry:
        frappe.throw(_("No open POS Opening Entry found."))

    kots = frappe.get_all("Kitchen Order Ticket", 
        filters={"table": table, "company": profile.company, "docstatus": 0}, 
        fields=["name", "customer_name"]
    )
    
    if not kots:
        frappe.throw(_("No active orders found for this table."))

    final_customer = customer or kots[0].customer_name or "Walk-in"
    
    invoice = frappe.new_doc("POS Invoice")
    
    # CRITICAL: Linking invoice to opening entry using the field you just added
    invoice.pos_opening_entry = opening_entry
    
    invoice.customer = final_customer
    invoice.company = profile.company
    invoice.pos_profile = profile.name
    invoice.update_stock = 1 
    
    if frappe.get_meta("POS Invoice").get_field("custom_restaurant_table"):
        invoice.custom_restaurant_table = table

    for k in kots:
        kot_doc = frappe.get_doc("Kitchen Order Ticket", k.name)
        for item in kot_doc.items:
            invoice.append("items", {
                "item_code": item.item_code,
                "qty": item.qty,
                "price_list_rate": flt(item.rate),      
                "discount_percentage": flt(item.discount_percentage),
                "warehouse": profile.warehouse,
                "cost_center": profile.cost_center
            })

    invoice.set_missing_values()
    invoice.calculate_taxes_and_totals()

    payment_account = None
    for p in profile.payments:
        if p.mode_of_payment == mode_of_payment:
            payment_account = getattr(p, 'default_account', None) or getattr(p, 'account', None)
            break
            
    if not payment_account:
        payment_account = frappe.db.get_value("Mode of Payment Account", 
            {"parent": mode_of_payment, "company": profile.company}, "default_account")

    invoice.append("payments", {
        "mode_of_payment": mode_of_payment,
        "account": payment_account,
        "amount": flt(amount_paid) 
    })

    invoice.insert()
    invoice.submit()

    # Double-check the link persists after submission
    frappe.db.set_value("POS Invoice", invoice.name, "pos_opening_entry", opening_entry)

    # --- POST-INVOICE CLEANUP ---
    for k in kots:
        frappe.db.set_value("Kitchen Order Ticket", k.name, "docstatus", 1)
    
    frappe.db.commit()
    return invoice.name

# --- CLOSING LOGIC ---

# --- CLOSING LOGIC ---

@frappe.whitelist()
def close_pos_opening_entry(opening_entry):
    opening_doc = frappe.get_doc("POS Opening Entry", opening_entry)
    
    # 1. Fetch all SUBMITTED invoices linked to this shift
    invoices = frappe.get_all("POS Invoice", 
        filters={"pos_opening_entry": opening_entry, "docstatus": 1},
        fields=["name", "grand_total", "net_total", "total_qty", "posting_date"]
    )
    
    if not invoices:
        frappe.throw(_("No submitted invoices found for this shift."))

    # 2. Create the Closing Entry
    closing_doc = frappe.new_doc("POS Closing Entry")
    closing_doc.pos_opening_entry = opening_entry
    closing_doc.pos_profile = opening_doc.pos_profile
    closing_doc.user = opening_doc.user
    closing_doc.company = opening_doc.company
    closing_doc.period_start_date = opening_doc.period_start_date
    closing_doc.period_end_date = now_datetime()

    # 3. Populate Linked Invoices
    for inv in invoices:
        closing_doc.append("pos_transactions", {
            "pos_invoice": inv.name,
            "grand_total": inv.grand_total,
            "posting_date": inv.posting_date
        })

    # 4. Map Opening Amounts from Opening Entry to a dictionary
    opening_amounts = {d.mode_of_payment: d.opening_amount for d in opening_doc.balance_details}

    # 5. Aggregate Payments (Cash, Gcash, etc.)
    payment_data = frappe.db.sql("""
        SELECT p.mode_of_payment, SUM(p.amount) as total_amount
        FROM `tabSales Invoice Payment` p
        JOIN `tabPOS Invoice` inv ON p.parent = inv.name
        WHERE inv.pos_opening_entry = %s AND inv.docstatus = 1
        GROUP BY p.mode_of_payment
    """, (opening_entry), as_dict=1)

    # 6. Populate Payment Reconciliation (Fixes the "Value Missing" Error)
    for pay in payment_data:
        mop = pay.mode_of_payment
        # We fetch the opening amount for this specific MOP, or default to 0
        opening_amt = flt(opening_amounts.get(mop, 0))
        
        closing_doc.append("payment_reconciliation", {
            "mode_of_payment": mop,
            "opening_amount": opening_amt,         # REQUIRED FIELD
            "expected_amount": opening_amt + flt(pay.total_amount),
            "closing_amount": opening_amt + flt(pay.total_amount)
        })

    # 7. Finalize totals
    closing_doc.grand_total = sum(inv.grand_total for inv in invoices)
    closing_doc.net_total = sum(inv.net_total for inv in invoices)
    closing_doc.total_quantity = sum(inv.total_qty for inv in invoices)

    closing_doc.insert()
    closing_doc.submit()
    
    return closing_doc.name

    # 8. Barcode

# 8. Barcode

@frappe.whitelist()
def get_item_by_barcode(barcode):
    # Search in the Item Barcode child table first
    item_code = frappe.db.get_value("Item Barcode", {"barcode": barcode}, "parent")
    
    # If not found in barcodes, check if the barcode matches an Item Code directly
    if not item_code:
        if frappe.db.exists("Item", barcode):
            item_code = barcode

    if item_code:
        profile = get_assigned_pos_profile()
        # Fetch item details including image and price from the specific price list
        item_data = frappe.db.sql("""
            SELECT 
                i.item_code, i.item_name, i.image,
                COALESCE((SELECT price_list_rate FROM `tabItem Price` 
                          WHERE item_code = i.item_code 
                          AND price_list = %s 
                          LIMIT 1), i.standard_rate) as standard_rate
            FROM `tabItem` i 
            WHERE i.name = %s
        """, (profile.selling_price_list, item_code), as_dict=1)

        return item_data[0] if item_data else None
    
    return None