local TAG = "[playdata]"

local function log(msg)
    cfb.log(TAG .. " " .. msg)
end

local function read_string(address, maxLen)
    local chars = {}

    for i = 0, maxLen - 1 do
        local ok, b = pcall(cfb.read_u8, address + i)

        if not ok or b == 0 then
            break
        end

        if b < 32 or b > 126 then
            break
        end

        chars[#chars + 1] = string.char(b)
    end

    return table.concat(chars)
end

log("===== BEGIN =====")

-- ASCII: PLAYDATA_
local hits = cfb.aob_scan(
    "50 4C 41 59 44 41 54 41 5F",
    512
)

log(string.format("prefix hits=%d", #hits))

local seen = {}

for _, address in ipairs(hits) do
    local s = read_string(address, 128)

    if string.sub(s, 1, 9) == "PLAYDATA_" and not seen[s] then
        seen[s] = true

        log(string.format(
            "0x%X  %s",
            address,
            s
        ))
    end
end

log("===== END =====")
