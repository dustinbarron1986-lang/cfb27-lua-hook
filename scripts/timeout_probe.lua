local function read_u64(address)
    local value = 0
    for i = 7, 0, -1 do
        value = value * 256 + cfb.read_u8(address + i)
    end
    return value
end

local module = cfb.module_base()
local state = read_u64(module + 0x0F2A12C8)

if state == 0 then
    error("timeout_probe: state pointer is null")
end

local START_OFFSET = 0x1100
local END_OFFSET   = 0x1250

local current = {}

for offset = START_OFFSET, END_OFFSET do
    local ok, value = pcall(cfb.read_u8, state + offset)

    if ok then
        current[offset] = value
    else
        current[offset] = -1
    end
end

if TIMEOUT_PROBE_BASELINE == nil then
    TIMEOUT_PROBE_BASELINE = current

    cfb.log("[timeout-probe] BASELINE SAVED")
    cfb.log(string.format(
        "[timeout-probe] state=%X range=+0x%X..+0x%X",
        state,
        START_OFFSET,
        END_OFFSET
    ))
else
    cfb.log("[timeout-probe] COMPARING AGAINST BASELINE")

    local interesting = 0

    for offset = START_OFFSET, END_OFFSET do
        local before = TIMEOUT_PROBE_BASELINE[offset]
        local after  = current[offset]

        if before ~= nil
            and after ~= nil
            and before >= 0
            and after >= 0
            and before ~= after then

            -- Timeout counters should be tiny integer values.
            if before <= 5 and after <= 5 then
                cfb.log(string.format(
                    "[timeout-probe] +0x%04X : %d -> %d",
                    offset,
                    before,
                    after
                ))

                interesting = interesting + 1
            end
        end
    end

    cfb.log(string.format(
        "[timeout-probe] %d interesting changes",
        interesting
    ))
end