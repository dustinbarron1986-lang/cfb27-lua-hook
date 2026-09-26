local TAG = "[api-pool]"

local function log(msg)
    cfb.log(TAG .. " " .. msg)
end

local function is_name_char(b)
    return
        (b >= 65 and b <= 90) or     -- A-Z
        (b >= 48 and b <= 57) or     -- 0-9
        b == 95                      -- _
end

local function interesting(s)
    return
        string.sub(s, 1, 3) == "GET" or
        string.sub(s, 1, 3) == "SET" or
        string.sub(s, 1, 2) == "IS" or
        string.find(s, "PLAY", 1, true) or
        string.find(s, "FORM", 1, true) or
        string.find(s, "TIMEOUT", 1, true)
end

log("===== BEGIN =====")

local base = cfb.module_base()

-- Known gameplay-Lua names are clustered roughly here.
local startAddress = base + 0x0B69CC00
local endAddress   = base + 0x0B69D800

local address = startAddress

while address < endAddress do
    local ok, first = pcall(cfb.read_u8, address)

    if ok and is_name_char(first) then
        local chars = {}
        local p = address

        while p < endAddress do
            local ok2, b = pcall(cfb.read_u8, p)

            if not ok2 or not is_name_char(b) then
                break
            end

            chars[#chars + 1] = string.char(b)

            if #chars >= 64 then
                break
            end

            p = p + 1
        end

        local s = table.concat(chars)

        if #s >= 4 and interesting(s) then
            log(string.format(
                "0x%X  %s",
                address,
                s
            ))
        end

        if p > address then
            address = p
        else
            address = address + 1
        end
    else
        address = address + 1
    end
end

log("===== END =====")