export const TOOLS_HUKUK = [
    {
        type: "function",
        function: {
            name: "submit_legal_handoff",
            description: "Müşterinin hukuk bürosuyla görüşme veya randevu talebini kaydeder. İsim, telefon ve konu özeti alındığında bu fonksiyonu çağır. Kullanıcı 'randevu istiyorum' derse veya iletişim bilgilerini verirse kullan.",
            strict: true,
            parameters: {
                type: "object",
                properties: {
                    contact_name: {
                        type: "string",
                        description: "Müşterinin adı ve soyadı."
                    },
                    contact_phone: {
                        type: "string",
                        description: "Müşterinin telefon numarası."
                    },
                    summary: {
                        type: "string",
                        description: "Hukuki sorunun veya talebin kısa özeti."
                    },
                    details: {
                        type: "string",
                        description: "Varsa olayın detayları, tarihçesi veya ek bilgiler."
                    },
                    category: {
                        type: "string",
                        enum: ["aile", "ceza", "is", "icra", "gayrimenkul", "tazminat", "diger"],
                        description: "Hukuki konunun kategorisi."
                    },
                    meeting_mode: {
                        type: "string",
                        enum: ["online", "yuz_yuze", "belirsiz"],
                        description: "Tercih edilen görüşme yöntemi."
                    },
                    urgency: {
                        type: "string",
                        enum: ["normal", "acil"],
                        description: "Durumun aciliyeti."
                    }
                },
                required: ["contact_name", "contact_phone", "summary", "category", "meeting_mode", "urgency", "details"],
                additionalProperties: false
            }
        }
    }
];

export const TOOLS_EMLAK = [
    {
        type: "function",
        function: {
            name: "submit_real_estate_lead",
            description: "Gayrimenkul alım/satım/kiralama talebi oluşturan müşteriyi kaydeder. İletişim bilgileri ve talep detayları alındığında çağır.",
            strict: true,
            parameters: {
                type: "object",
                properties: {
                    contact_name: {
                        type: "string",
                        description: "Müşterinin adı soyadı."
                    },
                    contact_phone: {
                        type: "string",
                        description: "Telefon numarası."
                    },
                    transaction_type: {
                        type: "string",
                        enum: ["satilik", "kiralik", "satiyorum", "kiraya_veriyorum", "danismanlik"],
                        description: "İşlem türü."
                    },
                    property_type: {
                        type: "string",
                        enum: ["daire", "villa", "arsa", "is_yeri", "diger"],
                        description: "İlgilenilen mülk tipi."
                    },
                    location: {
                        type: "string",
                        description: "Aranan veya satılan mülkün konumu (İlçe, Mahalle)."
                    },
                    budget_min: {
                        type: "number",
                        description: "Minimum bütçe (varsa) - 0 girebilirsin."
                    },
                    budget_max: {
                        type: "number",
                        description: "Maksimum bütçe (varsa) - 0 girebilirsin."
                    },
                    details: {
                        type: "string",
                        description: "Ek istekler (balkonlu, sıfır bina, krediye uygun vb.) veya genel notlar."
                    }
                },
                required: ["contact_name", "contact_phone", "transaction_type", "property_type", "location", "details", "budget_min", "budget_max"],
                additionalProperties: false
            }
        }
    }
];

export function getBrandTools(brandKey) {
    if (/emlak|stein/i.test(brandKey || "")) {
        return TOOLS_EMLAK;
    }
    return TOOLS_HUKUK;
}
