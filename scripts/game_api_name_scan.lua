local TAG = "[game-api]"

local function log(msg)
    cfb.log(TAG .. " " .. msg)
end

local function string_pattern(text)
    local out = {}

    for i = 1, #text do
        out[#out + 1] = string.format("%02X", string.byte(text, i))
    end

    out[#out + 1] = "00"

    return table.concat(out, " ")
end

local names = {
    "GETOFFTIMEOUTS",
    "GETDEFTIMEOUTS",
    "GETOFFFORMATION",
    "GETOFFPLAYGROUP",
    "GETDEFPLAYGROUP",
    "GETDEFOFFSETTYPE",
    "ISOFFENSIVEPLAYARUN",
    "ISOFFENSIVEPLAYAPASS",
    "SETPLAYGROUP",
    "SETPLAY",
    "GETOFFPLAYBOOK"
}

log("===== BEGIN =====")

for _, name in ipairs(names) do
    local pattern = string_pattern(name)

    local ok, hits = pcall(cfb.aob_scan, pattern, 16)

    if not ok then
        log(name .. " ERROR " .. tostring(hits))
    elseif type(hits) ~= "table" then
        log(name .. " unexpected result")
    else
        log(string.format("%-24s matches=%d", name, #hits))

        for i, address in ipairs(hits) do
            log(string.format(
                "  %s[%d] = 0x%X",
                name,
                i,
                address
            ))
        end
    end
end

log("===== END =====")