cfb.log("[cfb-api] ===== BEGIN =====")

local entries = {}

local ok, err = pcall(function()
    for name, value in pairs(cfb) do
        table.insert(entries, {
            name = tostring(name),
            kind = type(value)
        })
    end
end)

if not ok then
    cfb.log("[cfb-api] pairs(cfb) failed: " .. tostring(err))
else
    table.sort(entries, function(a, b)
        return a.name < b.name
    end)

    for _, entry in ipairs(entries) do
        cfb.log(string.format(
            "[cfb-api] %-32s %s",
            entry.name,
            entry.kind
        ))
    end
end

cfb.log("[cfb-api] ===== END =====")