cfb.log("[deer-api] ===== BEGIN =====")

-- First, discover anything exposed to this Lua state
-- whose name mentions TIMEOUT.
local found = 0

for name, value in pairs(_G) do
    if type(name) == "string" then
        local upper = string.upper(name)

        if string.find(upper, "TIMEOUT", 1, true) then
            cfb.log(string.format(
                "[deer-api] global %-32s type=%s",
                name,
                type(value)
            ))
            found = found + 1
        end
    end
end

cfb.log(string.format(
    "[deer-api] timeout globals found=%d",
    found
))

-- Probe known Deer functions without changing anything.
local probes = {
    "GETOFFTIMEOUTS",
    "GETDEFTIMEOUTS",
    "GETHOMETIMEOUTS",
    "GETAWAYTIMEOUTS",
    "GETTIMEOUTS",
    "GETDOWN",
    "GETQUARTER",
    "GETTIMEREMAINING",
    "SETPLAYGROUP"
}

for _, name in ipairs(probes) do
    local value = rawget(_G, name)

    cfb.log(string.format(
        "[deer-api] %-24s type=%s",
        name,
        type(value)
    ))

    -- Only CALL GET functions. Never invoke SETPLAYGROUP here.
    if type(value) == "function"
        and string.sub(name, 1, 3) == "GET" then

        local ok, result = pcall(value)

        if ok then
            cfb.log(string.format(
                "[deer-api] CALL %-19s => %s",
                name,
                tostring(result)
            ))
        else
            cfb.log(string.format(
                "[deer-api] CALL %-19s ERROR => %s",
                name,
                tostring(result)
            ))
        end
    end
end

cfb.log("[deer-api] ===== END =====")