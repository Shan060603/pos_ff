frappe.pages['pos_page'].on_page_load = function(wrapper) {
    var page = frappe.ui.make_app_page({
        parent: wrapper,
        title: 'Farmfresh POS',
        single_column: true
    });

    $(frappe.render_template("pos_page", {})).appendTo(page.main);

    // --- State Variables ---
    let cart = []; 
    let selected_table = null;
    let selected_customer = "Walk-in";
    let all_items = []; 
    let pos_profile = null; 
    let current_opening_entry = null;

    // --- 1. Shift Management & Initial Load ---
    function load_initial_data() {
        frappe.call({
            method: "pos_ff.api.check_pos_opening",
            callback: function(r) {
                if (r.message && !r.message.opening_entry) {
                    show_opening_dialog(r.message.pos_profile);
                } else {
                    current_opening_entry = r.message.opening_entry;
                    fetch_main_pos_data();
                }
            }
        });
    }

    function show_opening_dialog(profile_name) {
        const d = new frappe.ui.Dialog({
            title: __('Start POS Shift'),
            fields: [
                {
                    fieldtype: 'HTML',
                    options: `
                        <div class="text-center p-3">
                            <i class="fa fa-cash-register fa-4x text-primary mb-3"></i>
                            <h5 class="fw-bold">Welcome to ${profile_name}</h5>
                            <p class="text-muted">Enter the starting cash balance to open your shift.</p>
                        </div>
                    `
                },
                { label: 'Opening Cash Balance', fieldname: 'amount', fieldtype: 'Currency', default: 0, reqd: 1 }
            ],
            primary_action_label: __('Open POS'),
            primary_action(values) {
                frappe.call({
                    method: "pos_ff.api.create_opening_entry",
                    args: { pos_profile: profile_name, amount: values.amount },
                    freeze: true,
                    callback: (r) => {
                        d.hide();
                        current_opening_entry = r.message;
                        frappe.show_alert({message: __('Shift Started Successfully'), indicator: 'green'});
                        fetch_main_pos_data();
                    }
                });
            }
        });
        d.no_cancel_flag = true;
        d.show();
    }

    // --- NEW: Closing Shift Logic ---
// --- Optimized: Closing Shift Logic with Summary ---
    function show_closing_dialog() {
        if (!current_opening_entry) return;

        // Fetch current shift totals first to show the user what they are closing
        frappe.call({
            method: "frappe.client.get_list",
            args: {
                doctype: "POS Invoice",
                filters: { pos_opening_entry: current_opening_entry, docstatus: 1 },
                fields: ["SUM(grand_total) as total_sales", "COUNT(name) as count"]
            },
            callback: function(r) {
                const summary = r.message[0] || { total_sales: 0, count: 0 };
                
                const d = new frappe.ui.Dialog({
                    title: __('Finalize POS Shift'),
                    fields: [
                        {
                            fieldtype: 'HTML',
                            options: `
                                <div class="p-3 bg-light rounded text-center border">
                                    <i class="fa fa-flag-checkered fa-3x text-primary mb-3"></i>
                                    <h6 class="fw-bold">Shift: ${current_opening_entry}</h6>
                                    <div class="row mt-3">
                                        <div class="col-6 border-right">
                                            <small class="text-muted d-block">Total Sales</small>
                                            <span class="fw-bold text-success" style="font-size: 1.2rem;">
                                                ${format_currency(summary.total_sales)}
                                            </span>
                                        </div>
                                        <div class="col-6">
                                            <small class="text-muted d-block">Invoices</small>
                                            <span class="fw-bold" style="font-size: 1.2rem;">
                                                ${summary.count}
                                            </span>
                                        </div>
                                    </div>
                                    <hr>
                                    <p class="small text-muted">
                                        All Expected Amounts (Cash, Gcash, etc.) will be automatically set as your Actual Amounts.
                                    </p>
                                </div>
                            `
                        }
                    ],
                    primary_action_label: __('Confirm & Close Shift'),
                    primary_action() {
                        frappe.confirm(__('Are you sure? This will finalize all accounts for this shift.'), () => {
                            frappe.call({
                                method: "pos_ff.api.close_pos_opening_entry",
                                args: { opening_entry: current_opening_entry },
                                freeze: true,
                                callback: (res) => {
                                    if (!res.exc) {
                                        frappe.show_alert({
                                            message: __('Shift Closed & Totals Consolidated'), 
                                            indicator: 'blue'
                                        });
                                        // Force a clean state for the next shift
                                        window.location.reload(); 
                                    }
                                }
                            });
                        });
                    }
                });
                d.show();
            }
        });
    }

    // --- 2. Main Data Orchestration ---
    function fetch_main_pos_data() {
        frappe.call({
            method: "pos_ff.api.get_pos_data",
            callback: function(r) {
                if (!r.message) return;
                
                pos_profile = r.message.profile_settings;
                all_items = r.message.items; 

                $(wrapper).find('#branch-name').html(`<i class="fa fa-map-marker"></i> ${pos_profile.name}`);
                render_table_grid(r.message.tables);
                setup_customer_search();

                // --- SEARCH BAR LOGIC ---
                $(wrapper).find('#menu-search').off('keyup').on('keyup', function() {
                    let val = $(this).val().toLowerCase();
                    let filtered = all_items.filter(i => 
                        (i.item_name || "").toLowerCase().includes(val) || 
                        (i.item_code || "").toLowerCase().includes(val)
                    );
                    render_menu(filtered);
                });

                // --- UI Button Listeners ---
                $(wrapper).find('#close-shift-btn').off('click').on('click', () => show_closing_dialog());
                
                $(wrapper).find('#transfer-table-btn').off('click').on('click', function() {
                    if (!selected_table) return;
                    show_transfer_dialog();
                });

                $(wrapper).find('#clear-table-btn, #clear-table-mobile').off('click').on('click', function() {
                    if (!selected_table) return;
                    frappe.confirm(`Mark ${selected_table} as Available?`, () => {
                        update_table_status(selected_table, 'Available', false, {hide: () => {}});
                        $('#pos-interface').fadeOut(() => {
                            $('#table-picker-overlay').fadeIn();
                            selected_table = null;
                        });
                    });
                });
            }
        });
    }

    // --- 3. Customer & Table Logic ---
    function setup_customer_search() {
        let cust_search_box = $(wrapper).find('#customer-search');
        if (cust_search_box.length) {
            frappe.ui.form.make_control({
                df: {
                    fieldtype: "Link", options: "Customer", placeholder: "Search Customer...",
                    onchange: function() {
                        if(this.value) {
                            selected_customer = this.value;
                            $(wrapper).find('#selected-customer-display').text("Customer: " + selected_customer);
                        }
                    }
                },
                parent: cust_search_box.parent(),
                render_input: true
            });
            cust_search_box.remove();
        }
    }

    function render_table_grid(tables) {
        const btnContainer = $(wrapper).find('#table-buttons');
        btnContainer.empty();
        tables.forEach(t => {
            const statusClass = t.status.toLowerCase();
            let btn = $(`
                <div class="table-card status-${statusClass} ${t.status === 'Occupied' ? 'occupied' : ''}">
                    <div class="fw-bold">${t.name}</div>
                    <div class="small" style="font-size: 0.7rem; opacity: 0.9;">${t.status}</div>
                </div>
            `);
            btn.on('click', () => open_table_manager(t));
            btnContainer.append(btn);
        });
    }

    function open_table_manager(table) {
        const d = new frappe.ui.Dialog({
            title: `Table: ${table.name}`,
            fields: [
                { label: 'Status', fieldname: 'status', fieldtype: 'Select', options: ['Available', 'Occupied', 'Reserved', 'Dirty'], default: table.status }
            ],
            primary_action_label: 'Start/Open Order',
            primary_action(values) {
                update_table_status(table.name, values.status, true, d);
            },
            secondary_action_label: __('Update Status'),
            secondary_action() {
                update_table_status(table.name, d.get_values().status, false, d);
            }
        });
        d.show();
    }

    function update_table_status(table_name, status, enter_pos, dialog) {
        frappe.call({
            method: "pos_ff.api.update_table_status",
            args: { table: table_name, status: status },
            callback: (r) => {
                dialog.hide();
                if (enter_pos) {
                    selected_table = table_name;
                    $('#table-picker-overlay').fadeOut();
                    $('#pos-interface').css('display', 'flex').hide().fadeIn();
                    page.set_title(`${pos_profile.name} - ${table_name}`);
                    render_menu(all_items);
                    load_table_orders(); 
                } else {
                    fetch_main_pos_data(); 
                }
            }
        });
    }

    function show_transfer_dialog() {
        const d = new frappe.ui.Dialog({
            title: __('Move Order'),
            fields: [
                { label: __('From'), fieldname: 'from', fieldtype: 'Data', default: selected_table, read_only: 1 },
                { 
                    label: __('Move To'), fieldname: 'to', fieldtype: 'Link', options: 'Restaurant Table', reqd: 1,
                    get_query: () => ({ filters: { 'status': 'Available', 'company': pos_profile.company } }) 
                }
            ],
            primary_action_label: __('Confirm Move'),
            primary_action(values) {
                frappe.call({
                    method: "pos_ff.api.transfer_table",
                    args: { old_table: values.from, new_table: values.to },
                    callback: (r) => {
                        d.hide();
                        selected_table = values.to;
                        page.set_title(`${pos_profile.name} - ${selected_table}`);
                        load_table_orders(); 
                        frappe.show_alert({message: __('Table Moved'), indicator: 'green'});
                    }
                });
            }
        });
        d.show();
    }

    // --- 4. Menu & Cart Logic ---
    function render_menu(items) {
        const container = $(wrapper).find('#item-grid');
        container.empty();
        items.forEach(item => {
            const img_url = item.image || '/assets/frappe/images/default-image.png';
            let card = $(`
                <div class="menu-card-box">
                    <div class="menu-card-image" style="background-image: url('${img_url}')"></div>
                    <div class="menu-card-content">
                        <div class="item-name"><b>${item.item_name || item.item_code}</b></div>
                        <div class="item-price text-success">${format_currency(item.standard_rate)}</div>
                    </div>
                </div>
            `);
            card.on('click', () => add_to_cart(item));
            container.append(card);
        });
    }

    function add_to_cart(item) {
        let existing = cart.find(i => i.item_code === item.item_code && !i.is_fired);
        if (existing) {
            existing.qty += 1;
        } else {
            cart.push({ 
                item_code: item.item_code, item_name: item.item_name || item.item_code, 
                rate: item.standard_rate, qty: 1, note: "", discount_percentage: 0, is_fired: false
            });
        }
        update_cart_display();
    }

    function update_cart_display() {
        const cartList = $(wrapper).find('#cart-items');
        cartList.empty();
        let total = 0;

        cart.forEach((item, index) => {
            let disc = flt(item.discount_percentage);
            let price = item.rate * (1 - disc / 100);
            total += price * item.qty;

            let row = $(`
                <div class="cart-row border-bottom py-2 ${item.is_fired ? 'fired-item bg-light' : ''}">
                    <div class="d-flex justify-content-between align-items-center">
                        <div class="item-info">
                            <div class="fw-bold">${item.item_name} ${item.is_fired ? '✅' : ''}</div>
                            <div class="small d-flex gap-2 mt-1">
                                <span class="item-note-display text-primary cursor-pointer">${item.note ? '📝' : '<i class="fa fa-pencil"></i>'}</span>
                                <span class="item-discount-display text-success cursor-pointer">${disc > 0 ? disc + '%' : '<i class="fa fa-tag"></i>'}</span>
                                <span class="text-muted">${format_currency(price)}</span>
                            </div>
                        </div>
                        <div class="qty-controls">
                            ${!item.is_fired ? `
                                <button class="btn btn-xs btn-outline-secondary" onclick="window.update_qty(${index}, -1)">-</button>
                                <span class="mx-1 fw-bold">${item.qty}</span>
                                <button class="btn btn-xs btn-outline-secondary" onclick="window.update_qty(${index}, 1)">+</button>
                            ` : `<span class="badge badge-light border">x${item.qty}</span>`}
                        </div>
                    </div>
                </div>
            `);
            if(!item.is_fired) {
                row.find('.item-note-display').on('click', () => add_item_note(index));
                row.find('.item-discount-display').on('click', () => apply_item_discount(index));
            }
            cartList.append(row);
        });
        $(wrapper).find('#grand-total').text(format_currency(total));
    }

    function add_item_note(index) {
        frappe.prompt([{ label: 'Note', fieldname: 'note', fieldtype: 'Small Text', default: cart[index].note }], 
        (v) => { cart[index].note = v.note; update_cart_display(); }, __('Instructions'));
    }

    function apply_item_discount(index) {
        frappe.prompt([{ label: 'Discount %', fieldname: 'disc', fieldtype: 'Percent', default: cart[index].discount_percentage }], 
        (v) => { cart[index].discount_percentage = flt(v.disc); update_cart_display(); }, __('Apply Discount'));
    }

    window.update_qty = (index, delta) => {
        cart[index].qty += delta;
        if (cart[index].qty <= 0) cart.splice(index, 1);
        update_cart_display();
    };

    function load_table_orders() {
        frappe.call({
            method: "pos_ff.api.get_table_orders",
            args: { table: selected_table },
            callback: (r) => {
                cart = [];
                if(r.message) {
                    r.message.forEach(i => {
                        cart.push({ ...i, is_fired: true });
                    });
                }
                update_cart_display();
            }
        });
    }

    // --- 5. Final Actions (KOT & Checkout) ---
    $(wrapper).find('#fire-kot').on('click', function() {
        let new_items = cart.filter(i => !i.is_fired);
        if (!new_items.length) return;
        frappe.call({
            method: "pos_ff.api.create_kot",
            args: { table: selected_table, items: new_items, customer_name: selected_customer },
            callback: () => {
                frappe.show_alert({message: __('KOT Sent'), indicator: 'green'});
                load_table_orders();
            }
        });
    });

    $(wrapper).find('#checkout-btn').on('click', function() {
        if (!selected_table || !cart.length) return;
        if (cart.some(i => !i.is_fired)) {
            frappe.msgprint(__("Fire KOT first."));
            return;
        }

        let total = cart.reduce((acc, i) => acc + (i.rate * i.qty * (1 - i.discount_percentage/100)), 0);
        let payment_modes = pos_profile.payments.map(p => p.mode_of_payment);

        const d = new frappe.ui.Dialog({
            title: `Checkout - ${selected_table}`,
            fields: [
                { label: 'Total', fieldname: 'total', fieldtype: 'Currency', default: total, read_only: 1 },
                { label: 'Mode', fieldname: 'mode', fieldtype: 'Select', options: payment_modes, default: 'Cash' },
                { label: 'Received', fieldname: 'paid', fieldtype: 'Currency', default: total },
                { label: 'Change', fieldname: 'change', fieldtype: 'Currency', default: 0, read_only: 1 }
            ],
            primary_action_label: 'Confirm Payment',
            primary_action(values) {
                frappe.call({
                    method: "pos_ff.api.create_invoice",
                    args: { table: selected_table, mode_of_payment: values.mode, amount_paid: values.paid, customer: selected_customer },
                    callback: () => {
                        frappe.show_alert({message: __('Paid'), indicator: 'green'});
                        cart = []; selected_table = null;
                        $('#pos-interface').fadeOut(() => { $('#table-picker-overlay').fadeIn(); fetch_main_pos_data(); });
                    }
                });
                d.hide();
            }
        });
        
        d.fields_dict.paid.df.onchange = () => {
            let change = flt(d.get_value('paid')) - total;
            d.set_value('change', change > 0 ? change : 0);
        };
        d.show();
        d.get_field('paid').$input.focus().select();
    });

    // --- 6. Barcode Scanner Logic (AUTOMATED) ---
    let barcode_buffer = "";
    let barcode_timer = null;

    $(window).on('keypress', function(e) {
        // Ignore if user is typing in an actual input field (like Search or Dialogs)
        if ($(e.target).is('input, textarea, select')) return;

        // Clear timer on every keypress
        if (barcode_timer) clearTimeout(barcode_timer);

        // Build the barcode string
        barcode_buffer += String.fromCharCode(e.which);

        // 100ms delay: if no more keys are pressed, process the scan
        barcode_timer = setTimeout(() => {
            if (barcode_buffer.length >= 3) {
                process_barcode(barcode_buffer.trim());
            }
            barcode_buffer = "";
        }, 100); 
    });

    function process_barcode(barcode) {
        frappe.call({
            method: "pos_ff.api.get_item_by_barcode",
            args: { barcode: barcode },
            callback: function(r) {
                if (r.message) {
                    // Call your existing add_to_cart function
                    add_to_cart(r.message);
                    frappe.show_alert({
                        message: __(`${r.message.item_name} added to cart`), 
                        indicator: 'green'
                    }, 1);
                } else {
                    frappe.show_alert({
                        message: __(`Barcode ${barcode} not found`), 
                        indicator: 'red'
                    });
                }
            }
        });
    }

    load_initial_data();
};